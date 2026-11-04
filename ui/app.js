(() => {
  const workspace = document.querySelector("#workspace");
  const MAX_PANES = 8;
  const defaultPaths = ["~", "~/Downloads", "~/Documents"];
  const panes = new Map();
  const addButtons = [document.querySelector("#split-horizontal"), document.querySelector("#split-vertical")];
  let nextPaneId = 1;
  let layout;
  let activePane;

  function displayPath(path) {
    return path.startsWith("/home/") ? path.replace(/^\/home\/[^/]+/, "~") : path;
  }

  function requestDirectory(pane, path) {
    pane.status.textContent = "読み込み中…";
    pane.status.className = "status";
    window.webkit.messageHandlers.directoryListing.postMessage({ paneId: pane.id, path });
  }

  function requestOpen(pane, path, choose = false) {
    pane.status.textContent = "ファイルを開いています…";
    pane.status.className = "status";
    window.webkit.messageHandlers.fileOpen.postMessage({ paneId: pane.id, path, choose });
  }

  function fileAction(pane, action) {
    const entry = pane.entries[pane.selectedIndex];
    if (!entry || entry.directory) return;
    const path = `${pane.path}/${entry.name}`;
    if (action === "execute") {
      pane.status.textContent = "実行するファイルを確認しています…";
      pane.status.className = "status";
      window.webkit.messageHandlers.fileExecute.postMessage({ paneId: pane.id, path });
    } else requestOpen(pane, path, action === "choose");
  }

  function fileOperation(pane, action) {
    const entry = pane.entries[pane.selectedIndex];
    const usesFolder = ["paste", "new_folder", "new_file"].includes(action);
    if (!usesFolder && !entry) return;
    const path = usesFolder ? pane.path : `${pane.path}/${entry.name}`;
    pane.status.textContent = "ファイル操作を処理しています…";
    pane.status.className = "status";
    window.webkit.messageHandlers.fileOperation.postMessage({ paneId: pane.id, action, path });
  }

  const menu = document.createElement("div");
  menu.className = "file-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  for (const [label, action] of [["開く", "open"], ["別のアプリで開く", "choose"], ["実行", "execute"], ["名前を変更", "rename"], ["新しいフォルダ", "new_folder"], ["新しいファイル", "new_file"]]) {
    const button = document.createElement("button");
    button.textContent = label;
    button.dataset.action = action;
    button.setAttribute("role", "menuitem");
    button.addEventListener("click", () => {
      menu.hidden = true;
      if (activePane) {
        if (action.startsWith("new_") || action === "rename") fileOperation(activePane, action);
        else fileAction(activePane, action);
      }
    });
    menu.append(button);
  }
  document.body.append(menu);
  document.addEventListener("pointerdown", event => {
    if (!menu.contains(event.target)) menu.hidden = true;
  });

  function showFileMenu(event, pane, index) {
    event.preventDefault();
    if (index >= 0) selectEntry(pane, index, false);
    focusPane(pane);
    const isFile = index >= 0 && !pane.entries[index].directory;
    menu.querySelectorAll("button").forEach(button => {
      const action = button.dataset.action;
      button.hidden = action === "rename" ? index < 0 : !action.startsWith("new_") && !isFile;
    });
    menu.hidden = false;
    menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight))}px`;
  }

  function setActivePane(pane) {
    activePane = pane;
    panes.forEach(item => item.element.classList.toggle("focused", item === pane));
  }

  function focusPane(pane) {
    setActivePane(pane);
    requestAnimationFrame(() => {
      if (activePane === pane && panes.has(pane.id)) pane.element.focus({ preventScroll: true });
    });
  }

  function visiblePanes() {
    function collect(node) {
      return node.pane ? [node.pane] : [...collect(node.first), ...collect(node.second)];
    }
    return collect(layout);
  }

  function updateAddButtons() {
    addButtons.forEach(button => { button.disabled = panes.size >= MAX_PANES; });
  }

  function splitNode(first, second, direction) {
    return { first, second, direction, ratio: 0.5 };
  }

  function replacePane(node, pane, replacement) {
    if (node.pane === pane) return replacement;
    if (!node.pane) {
      node.first = replacePane(node.first, pane, replacement);
      node.second = replacePane(node.second, pane, replacement);
    }
    return node;
  }

  function removePane(node, pane) {
    if (node.pane) return node.pane === pane ? null : node;
    node.first = removePane(node.first, pane);
    node.second = removePane(node.second, pane);
    if (!node.first) return node.second;
    if (!node.second) return node.first;
    return node;
  }

  function siblingOf(node, pane) {
    if (node.pane) return null;
    if (node.first.pane === pane) return node.second;
    if (node.second.pane === pane) return node.first;
    return siblingOf(node.first, pane) || siblingOf(node.second, pane);
  }

  function firstPane(node) {
    return node.pane || firstPane(node.first);
  }

  function renderLayout() {
    function render(node) {
      if (node.pane) return node.pane.element;
      const split = document.createElement("div");
      split.className = `split ${node.direction}`;
      const first = document.createElement("div");
      const second = document.createElement("div");
      first.className = second.className = "split-child";
      const divider = document.createElement("div");
      divider.className = "divider";
      divider.title = node.direction === "horizontal" ? "左右の幅を変更" : "上下の高さを変更";
      const applyRatio = () => {
        first.style.flex = `${node.ratio} 1 0`;
        second.style.flex = `${1 - node.ratio} 1 0`;
      };
      applyRatio();
      divider.addEventListener("pointerdown", event => {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        divider.classList.add("dragging");
      });
      divider.addEventListener("pointermove", event => {
        if (!divider.hasPointerCapture(event.pointerId)) return;
        const bounds = split.getBoundingClientRect();
        const horizontal = node.direction === "horizontal";
        const total = (horizontal ? bounds.width : bounds.height) - 6;
        if (total <= 0) return;
        const position = (horizontal ? event.clientX - bounds.left : event.clientY - bounds.top) - 3;
        node.ratio = Math.max(0.1, Math.min(0.9, position / total));
        applyRatio();
      });
      divider.addEventListener("lostpointercapture", () => divider.classList.remove("dragging"));
      first.append(render(node.first));
      second.append(render(node.second));
      split.append(first, divider, second);
      return split;
    }
    workspace.replaceChildren(render(layout));
    updateAddButtons();
  }

  function addPane(direction) {
    if (!activePane || panes.size >= MAX_PANES) return;
    const source = activePane;
    const pane = makePane(source.path, false);
    layout = replacePane(layout, source, splitNode({ pane: source }, { pane }, direction));
    renderLayout();
    focusPane(pane);
  }

  function closePane() {
    if (!activePane) return;
    if (panes.size === 1) {
      window.webkit.messageHandlers.closeWindow.postMessage({});
      return;
    }
    const closing = activePane;
    const next = firstPane(siblingOf(layout, closing));
    layout = removePane(layout, closing);
    panes.delete(closing.id);
    renderLayout();
    focusPane(next);
  }

  function moveActivePane(offset) {
    const visible = visiblePanes();
    if (!visible.length) return;
    const currentIndex = Math.max(0, visible.indexOf(activePane));
    focusPane(visible[(currentIndex + offset + visible.length) % visible.length]);
  }

  function focusPaneByNumber(number) {
    const pane = visiblePanes()[number - 1];
    if (pane) focusPane(pane);
  }

  function selectEntry(pane, index, scroll = true) {
    const buttons = [...pane.list.querySelectorAll(".entry")];
    if (!buttons.length) return;
    pane.selectedIndex = Math.max(0, Math.min(index, buttons.length - 1));
    buttons.forEach((button, itemIndex) => button.classList.toggle("selected", itemIndex === pane.selectedIndex));
    if (scroll) buttons[pane.selectedIndex].scrollIntoView({ block: "nearest" });
  }

  function activateSelectedEntry(pane) {
    const entry = pane.entries[pane.selectedIndex];
    if (!entry) return;
    const path = `${pane.path}/${entry.name}`;
    if (entry.directory) requestDirectory(pane, path);
    else requestOpen(pane, path);
  }

  function handlePaneKeydown(event) {
    if (!activePane) return;
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      menu.hidden = true;
      focusPane(activePane);
      return;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "l" || key === "j" || key === "w") {
        event.preventDefault();
        if (key === "w") closePane();
        else addPane(key === "l" ? "horizontal" : "vertical");
        return;
      }
      if ((key === "o" || key === "e") && event.target !== activePane.input && event.target.closest("#workspace")) {
        event.preventDefault();
        menu.hidden = true;
        fileAction(activePane, key === "o" ? "choose" : "execute");
        return;
      }
    }
    const isTab = event.key === "Tab" || event.key === "ISO_Left_Tab" || event.code === "Tab";
    if (event.ctrlKey && isTab) {
      event.preventDefault();
      moveActivePane(event.shiftKey || event.key === "ISO_Left_Tab" ? -1 : 1);
    } else if (event.altKey && /^[1-3]$/.test(event.key)) {
      event.preventDefault();
      focusPaneByNumber(Number(event.key));
    } else if (event.target === activePane.input || (!event.target.closest("#workspace") && event.target !== document.body)) return;
    else if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && ["c", "x", "v"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      const action = { c: "copy", x: "cut", v: "paste" }[event.key.toLowerCase()];
      fileOperation(activePane, action);
    }
    else if (event.key === "Delete" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      fileOperation(activePane, "trash");
    }
    else if (event.key === "F2" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      fileOperation(activePane, "rename");
    }
    else if (event.key === "ArrowDown") { event.preventDefault(); selectEntry(activePane, activePane.selectedIndex + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selectEntry(activePane, activePane.selectedIndex - 1); }
    else if (event.key === "Enter") { event.preventDefault(); activateSelectedEntry(activePane); }
    else if (event.key === "Backspace") {
      event.preventDefault();
      activePane.element.querySelector(".up").click();
    } else if (event.key === "F5") {
      event.preventDefault();
      requestDirectory(activePane, activePane.path);
    }
  }

  function makePane(path, selectInitial = true) {
    const id = String(nextPaneId++);
    const element = document.createElement("section");
    element.className = "pane";
    element.dataset.paneId = id;
    const pane = { id, element, path, entries: [], selectedIndex: -1, selectInitial };
    element.innerHTML = `
      <div class="pane-header"><span class="pane-title">Pane ${id}</span>
        <button class="up" title="親フォルダへ">↑</button><input class="path" aria-label="フォルダのパス">
        <button class="go">移動</button></div><p class="status">準備中…</p><div class="entry-list"></div>`;
    pane.input = element.querySelector(".path");
    pane.status = element.querySelector(".status");
    pane.list = element.querySelector(".entry-list");
    pane.list.addEventListener("contextmenu", event => {
      const entry = event.target.closest(".entry");
      const index = entry ? [...pane.list.querySelectorAll(".entry")].indexOf(entry) : -1;
      showFileMenu(event, pane, index);
    });
    element.tabIndex = 0;
    const go = () => requestDirectory(pane, pane.input.value.trim());
    element.querySelector(".go").addEventListener("click", go);
    pane.input.addEventListener("keydown", event => { if (event.key === "Enter") go(); });
    element.querySelector(".up").addEventListener("click", () => {
      const path = pane.path || pane.input.value;
      requestDirectory(pane, `${path.replace(/\/$/, "")}/..`);
    });
    element.addEventListener("pointerdown", event => {
      setActivePane(pane);
      if (!event.target.closest(".path")) focusPane(pane);
    });
    element.addEventListener("focusin", () => setActivePane(pane));
    panes.set(pane.id, pane);
    requestDirectory(pane, pane.path);
    return pane;
  }

  window.dirGroup = {
    receiveDirectory(response) {
      const pane = panes.get(response.paneId);
      if (!pane) return;
      if (response.error) {
        pane.status.textContent = response.error;
        pane.status.className = "status error";
        if (pane === activePane) focusPane(pane);
        return;
      }
      pane.path = response.path;
      pane.entries = response.entries;
      pane.selectedIndex = pane.selectInitial ? 0 : -1;
      if (pane.pendingSelection) {
        if (response.path === pane.pendingSelection.directory) {
          const selectedIndex = response.entries.findIndex(entry => entry.name === pane.pendingSelection.name);
          if (selectedIndex >= 0) pane.selectedIndex = selectedIndex;
        }
        pane.pendingSelection = null;
      }
      pane.selectInitial = true;
      pane.input.value = displayPath(response.path);
      pane.status.textContent = `${response.entries.length} 件${response.truncated ? "（先頭 1,000 件）" : ""} · ↑↓ / Enter / Backspace / F5 · Ctrl+Tab / Alt+1〜3`;
      pane.status.className = "status";
      if (pane.operationNotice) {
        pane.status.textContent = pane.operationNotice.text;
        pane.status.className = pane.operationNotice.error ? "status error" : "status";
        pane.operationNotice = null;
      }
      pane.list.replaceChildren(...response.entries.map((entry, index) => {
        const button = document.createElement("button");
        button.className = "entry";
        button.innerHTML = `<span class="entry-icon">${entry.directory ? "📁" : "📄"}</span><span class="entry-name"></span>`;
        button.querySelector(".entry-name").textContent = entry.name;
        button.addEventListener("click", () => selectEntry(pane, index, false));
        button.addEventListener("dblclick", () => activateSelectedEntry(pane));
        return button;
      }));
      if (pane.selectedIndex >= 0) selectEntry(pane, pane.selectedIndex, false);
      if (pane === activePane) focusPane(pane);
    },
    receiveOpenResult(response) {
      const pane = panes.get(response.paneId);
      if (!pane) return;
      if (response.error) {
        pane.status.textContent = response.error;
        pane.status.className = "status error";
        if (pane === activePane) focusPane(pane);
        return;
      }
      pane.status.textContent = response.cancelled ? "操作をキャンセルしました。" : `${response.message}: ${displayPath(response.path)}`;
      pane.status.className = "status";
      if (pane === activePane) focusPane(pane);
    },
    receiveFileOperation(response) {
      const pane = panes.get(response.paneId);
      if (pane && response.selectedName && pane.path === response.selectedDirectory) {
        pane.pendingSelection = { name: response.selectedName, directory: response.selectedDirectory };
      }
      if (pane && response.refresh) pane.operationNotice = { text: response.error || response.message, error: !!response.error };
      if (response.refresh) panes.forEach(item => requestDirectory(item, item.path));
      if (!pane) return;
      pane.status.textContent = response.error || response.message;
      pane.status.className = response.error ? "status error" : "status";
      if (pane === activePane) focusPane(pane);
    }
  };

  const initial = defaultPaths.map(path => makePane(path));
  layout = splitNode({ pane: initial[0] }, splitNode({ pane: initial[1] }, { pane: initial[2] }, "vertical"), "horizontal");
  renderLayout();
  focusPane(initial[0]);
  document.addEventListener("keydown", handlePaneKeydown, true);
  addButtons[0].addEventListener("click", () => addPane("horizontal"));
  addButtons[1].addEventListener("click", () => addPane("vertical"));
  document.querySelector("#close-pane").addEventListener("click", closePane);
})();
