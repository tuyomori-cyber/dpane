(() => {
  const workspace = document.querySelector("#workspace");
  const MAX_PANES = 8;
  const defaultPaths = ["~", "~/Downloads", "~/Documents"];
  const panes = new Map();
  const scaleInput = document.querySelector("#ui-scale");
  const scaleValue = document.querySelector("#ui-scale-value");
  const hiddenFoldersInput = document.querySelector("#show-hidden-folders");
  const viewMenu = document.querySelector(".view-menu");
  let showHiddenFolders = hiddenFoldersInput.checked;
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

  function hideCompletion(pane, invalidate = true) {
    const state = pane.completion;
    if (!state) return;
    clearTimeout(state.timer);
    state.list.hidden = true;
    state.selected = -1;
    if (invalidate) {
      state.id++;
      state.result = null;
      state.wantTab = false;
      state.active = false;
    }
  }

  function requestCompletion(pane, wantTab = false, delay = 150) {
    const state = pane.completion;
    clearTimeout(state.timer);
    state.id++;
    state.value = pane.input.value;
    state.cursor = pane.input.selectionStart;
    state.selected = -1;
    state.result = null;
    state.wantTab = wantTab;
    state.active = true;
    state.list.hidden = true;
    const id = state.id;
    const prefix = state.value.slice(0, state.cursor);
    if (pane.input.selectionEnd !== state.cursor || !(prefix.startsWith("/") || prefix.startsWith("~/"))) { state.active = false; return; }
    const send = () => {
      state.timer = null;
      if (document.activeElement !== pane.input || id !== state.id) return;
      window.webkit.messageHandlers.pathCompletion.postMessage({ paneId: pane.id, requestId: id, path: prefix });
    };
    if (delay === 0) send();
    else state.timer = setTimeout(send, delay);
  }

  function positionCompletion(pane) {
    const rect = pane.input.getBoundingClientRect();
    const list = pane.completion.list;
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom}px`;
    list.style.width = `${rect.width}px`;
  }

  function renderCompletion(pane) {
    const state = pane.completion;
    const result = state.result;
    state.list.replaceChildren();
    if (!result || !result.candidates.length) { state.list.hidden = true; return; }
    result.candidates.forEach((name, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.className = "completion-option";
      button.textContent = `${name}/`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === state.selected));
      button.classList.toggle("selected", index === state.selected);
      button.addEventListener("pointerdown", event => event.preventDefault());
      button.addEventListener("click", () => applyCompletion(pane, name, true));
      state.list.append(button);
    });
    if (result.count > result.candidates.length) {
      const note = document.createElement("div");
      note.className = "completion-note";
      note.textContent = `${result.count} 件中 ${result.candidates.length} 件を表示`;
      state.list.append(note);
    }
    positionCompletion(pane);
    state.list.hidden = false;
    if (state.selected >= 0) state.list.children[state.selected].scrollIntoView({ block: "nearest" });
  }

  function applyCompletion(pane, name, complete) {
    const state = pane.completion;
    if (!name || document.activeElement !== pane.input || pane.input.value !== state.value || pane.input.selectionStart !== state.cursor) return;
    const left = state.value.slice(0, state.cursor);
    const parent = left.slice(0, left.lastIndexOf("/") + 1);
    const afterCursor = state.value.slice(state.cursor);
    const slash = afterCursor.indexOf("/");
    const rest = slash < 0 ? "" : afterCursor.slice(slash);
    const suffix = complete ? (rest || "/") : rest;
    pane.input.value = parent + name + suffix;
    const cursor = parent.length + name.length + (complete ? 1 : 0);
    pane.input.setSelectionRange(cursor, cursor);
    if (complete) {
      hideCompletion(pane);
      requestCompletion(pane);
    } else {
      state.value = pane.input.value;
      state.cursor = cursor;
      state.selected = -1;
      renderCompletion(pane);
    }
  }

  function setupCompletion(pane) {
    const list = document.createElement("div");
    list.className = "path-completions";
    list.hidden = true;
    list.setAttribute("role", "listbox");
    document.body.append(list);
    pane.completion = { list, id: 0, selected: -1, result: null, timer: null, wantTab: false, active: false };
    pane.input.addEventListener("input", () => requestCompletion(pane));
    pane.input.addEventListener("click", () => requestCompletion(pane));
    pane.input.addEventListener("blur", () => hideCompletion(pane));
    pane.input.addEventListener("keyup", event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) requestCompletion(pane);
    });
    pane.input.addEventListener("keydown", event => {
      const state = pane.completion;
      if (event.isComposing) return;
      if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        if (pane.input.value === "~") {
          pane.input.value = "~/";
          requestCompletion(pane);
        } else if (state.result && state.value === pane.input.value && state.cursor === pane.input.selectionStart) {
          applyCompletion(pane, state.result.common, state.result.count === 1);
        } else requestCompletion(pane, true, 0);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !state.list.hidden && state.result) {
        event.preventDefault();
        const count = state.result.candidates.length;
        state.selected = state.selected < 0 ? (event.key === "ArrowDown" ? 0 : count - 1)
          : (state.selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
        renderCompletion(pane);
      } else if (event.key === "Enter" && state.selected >= 0 && !state.list.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        applyCompletion(pane, state.result.candidates[state.selected], true);
      } else if (event.key === "Escape" && state.active) {
        event.preventDefault();
        hideCompletion(pane);
      }
    });
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
    if (!viewMenu.contains(event.target)) viewMenu.open = false;
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
    panes.forEach(pane => {
      pane.element.querySelectorAll(".split-horizontal, .split-vertical").forEach(button => {
        button.disabled = panes.size >= MAX_PANES;
      });
    });
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

  function addPane(direction, source = activePane) {
    if (!source || !panes.has(source.id) || panes.size >= MAX_PANES) return;
    const pane = makePane(source.path, false);
    layout = replacePane(layout, source, splitNode({ pane: source }, { pane }, direction));
    renderLayout();
    focusPane(pane);
  }

  function closePane(closing = activePane) {
    if (!closing || !panes.has(closing.id)) return;
    if (panes.size === 1) {
      window.webkit.messageHandlers.closeWindow.postMessage({});
      return;
    }
    const next = firstPane(siblingOf(layout, closing));
    layout = removePane(layout, closing);
    panes.delete(closing.id);
    hideCompletion(closing);
    closing.completion.list.remove();
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
    if (event.key === "Escape" && viewMenu.open && viewMenu.contains(event.target)) {
      event.preventDefault();
      viewMenu.open = false;
      viewMenu.querySelector("summary").focus();
      return;
    }
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
    const pane = { id, element, path, entries: [], allEntries: [], selectedIndex: -1, selectInitial };
    element.innerHTML = `
      <div class="pane-header"><span class="pane-title">Pane ${id}</span>
        <button class="up" title="親フォルダへ">↑</button><input class="path" aria-label="フォルダのパス">
        <button class="split-horizontal" title="右にペインを追加 (Ctrl+Shift+L)" aria-label="右にペインを追加">||</button>
        <button class="split-vertical" title="下にペインを追加 (Ctrl+Shift+J)" aria-label="下にペインを追加">＝</button>
        <button class="close-pane" title="このペインを閉じる" aria-label="このペインを閉じる">×</button>
        </div><p class="status">準備中…</p><div class="entry-list"></div>`;
    pane.input = element.querySelector(".path");
    setupCompletion(pane);
    pane.status = element.querySelector(".status");
    pane.list = element.querySelector(".entry-list");
    pane.list.addEventListener("contextmenu", event => {
      const entry = event.target.closest(".entry");
      const index = entry ? [...pane.list.querySelectorAll(".entry")].indexOf(entry) : -1;
      showFileMenu(event, pane, index);
    });
    element.tabIndex = 0;
    const go = () => { hideCompletion(pane); pane.submittingPath = pane.input.value; requestDirectory(pane, pane.input.value.trim()); };
    element.querySelector(".split-horizontal").addEventListener("click", () => addPane("horizontal", pane));
    element.querySelector(".split-vertical").addEventListener("click", () => addPane("vertical", pane));
    element.querySelector(".close-pane").addEventListener("click", () => closePane(pane));
    pane.input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) go(); });
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

  function renderEntries(pane, selectedName, selectFirst = false) {
    pane.entries = pane.allEntries.filter(entry => showHiddenFolders || !entry.directory || !entry.name.startsWith("."));
    const selectedIndex = pane.entries.findIndex(entry => entry.name === selectedName);
    pane.selectedIndex = selectedIndex >= 0 ? selectedIndex : (selectFirst && pane.entries.length ? 0 : -1);
    pane.list.replaceChildren(...pane.entries.map((entry, index) => {
      const button = document.createElement("button");
      button.className = "entry";
      button.innerHTML = `<span class="entry-icon">${entry.directory ? "📁" : "📄"}</span><span class="entry-name"></span>`;
      button.querySelector(".entry-name").textContent = entry.name;
      button.addEventListener("click", () => selectEntry(pane, index, false));
      button.addEventListener("dblclick", () => activateSelectedEntry(pane));
      return button;
    }));
    if (pane.selectedIndex >= 0) selectEntry(pane, pane.selectedIndex, false);
  }

  window.dirGroup = {
    receiveDirectory(response) {
      const pane = panes.get(response.paneId);
      if (!pane) return;
      const preserveInput = document.activeElement === pane.input &&
        (pane.submittingPath === undefined || pane.input.value !== pane.submittingPath);
      pane.submittingPath = undefined;
      if (response.error) {
        pane.status.textContent = response.error;
        pane.status.className = "status error";
        if (pane === activePane && !preserveInput) focusPane(pane);
        return;
      }
      pane.path = response.path;
      pane.allEntries = response.entries;
      pane.truncated = response.truncated;
      let selectedName;
      if (pane.pendingSelection) {
        if (response.path === pane.pendingSelection.directory) {
          selectedName = pane.pendingSelection.name;
        }
        pane.pendingSelection = null;
      }
      renderEntries(pane, selectedName, selectedName === undefined && pane.selectInitial);
      pane.selectInitial = true;
      if (!preserveInput) pane.input.value = displayPath(response.path);
      pane.status.textContent = `${pane.entries.length} 件${response.truncated ? "（取得上限 1,000 件）" : ""} · ↑↓ / Enter / Backspace / F5 · Ctrl+Tab / Alt+1〜3`;
      pane.status.className = "status";
      if (pane.operationNotice) {
        pane.status.textContent = pane.operationNotice.text;
        pane.status.className = pane.operationNotice.error ? "status error" : "status";
        pane.operationNotice = null;
      }
      if (pane === activePane && !preserveInput) focusPane(pane);
    },
    receivePathCompletion(response) {
      const pane = panes.get(response.paneId);
      if (!pane) return;
      const state = pane.completion;
      if (response.requestId !== state.id || document.activeElement !== pane.input ||
          pane.input.value !== state.value || pane.input.selectionStart !== state.cursor || pane.input.selectionEnd !== state.cursor) return;
      state.result = response;
      if (state.wantTab) {
        state.wantTab = false;
        if (response.common) applyCompletion(pane, response.common, response.count === 1);
      }
      if (state.result === response) renderCompletion(pane);
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
      if (pane === activePane && document.activeElement !== pane.input) focusPane(pane);
    }
  };

  const initial = defaultPaths.map(path => makePane(path));
  layout = splitNode({ pane: initial[0] }, splitNode({ pane: initial[1] }, { pane: initial[2] }, "vertical"), "horizontal");
  renderLayout();
  focusPane(initial[0]);
  document.addEventListener("keydown", handlePaneKeydown, true);
  scaleInput.addEventListener("input", () => {
    const percent = Number(scaleInput.value);
    scaleValue.textContent = `${percent}%`;
    window.webkit.messageHandlers.uiScale.postMessage({ percent });
  });
  hiddenFoldersInput.addEventListener("change", () => {
    showHiddenFolders = hiddenFoldersInput.checked;
    panes.forEach(pane => {
      const selectedName = pane.entries[pane.selectedIndex]?.name;
      renderEntries(pane, selectedName);
      pane.status.textContent = `${pane.entries.length} 件${pane.truncated ? "（取得上限 1,000 件）" : ""} · ↑↓ / Enter / Backspace / F5 · Ctrl+Tab / Alt+1〜3`;
      pane.status.className = "status";
    });
  });
})();
