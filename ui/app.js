(() => {
  const startupJsStart = window.dpaneStartupTiming ? performance.now() : 0;
  function reportStartup(event, extra = {}) {
    if (!window.dpaneStartupTiming) return;
    if (window.dpaneStartupSummary && !["dom-content-loaded", "window-load", "dom-already", "load-already"].includes(event)) return;
    window.webkit.messageHandlers.startupDetail.postMessage({
      event, elapsed: performance.now() - startupJsStart, ...extra
    });
  }
  function reportResourceTimings() {
    if (typeof performance.getEntriesByType !== "function") {
      reportStartup("performance-unavailable");
      return;
    }
    const relativeTime = value => Number.isFinite(value) && value > 0 ? value - startupJsStart : null;
    const entries = performance.getEntriesByType("resource");
    reportStartup("resource-summary", { count: entries.length });
    entries.slice(0, 30).forEach(entry => {
      const name = entry.name.split(/[?#]/, 1)[0];
      const kind = name.endsWith("/style.css") ? "style.css" : name.endsWith("/app.js") ? "app.js" : "other";
      reportStartup("resource", {
        kind, start: relativeTime(entry.startTime), end: relativeTime(entry.responseEnd), duration: entry.duration
      });
    });
    const navigation = performance.getEntriesByType("navigation")[0];
    if (!navigation) {
      reportStartup("navigation-unavailable");
      return;
    }
    reportStartup("navigation", {
      domStart: relativeTime(navigation.domContentLoadedEventStart),
      domEnd: relativeTime(navigation.domContentLoadedEventEnd),
      loadStart: relativeTime(navigation.loadEventStart),
      loadEnd: relativeTime(navigation.loadEventEnd)
    });
  }
  reportStartup("js-start");
  if (window.dpaneStartupTiming) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => reportStartup("dom-content-loaded"), { once: true });
    } else reportStartup("dom-already");
    if (document.readyState !== "complete") {
      window.addEventListener("load", () => {
        reportStartup("window-load");
        if (!window.dpaneStartupSummary) setTimeout(reportResourceTimings, 0);
      }, { once: true });
    } else {
      reportStartup("load-already");
      if (!window.dpaneStartupSummary) setTimeout(reportResourceTimings, 0);
    }
  }
  const workspace = document.querySelector("#workspace");
  const MAX_PANES = 8;
  const defaultPaths = ["~", "~/Downloads", "~/Documents", "~/Pictures"];
  const panes = new Map();
  const scaleInput = document.querySelector("#ui-scale");
  const scaleValue = document.querySelector("#ui-scale-value");
  const hiddenEntriesInput = document.querySelector("#show-hidden-entries");
  const shortcutHintsInput = document.querySelector("#show-shortcut-hints");
  const startupPaneCountInput = document.querySelector("#startup-pane-count");
  const viewMenu = document.querySelector(".view-menu");
  const helpMenu = document.querySelector(".help-menu");
  const settingsMenu = document.querySelector(".settings-menu");
  let keybindings = window.dpaneKeybindings;
  const bookmarkButton = document.querySelector("#bookmark-menu-button");
  const bookmarkPopup = document.querySelector("#bookmark-popup");
  let bookmarkPaths = window.dpaneInitialBookmarks?.paths || [];
  let bookmarkError = window.dpaneInitialBookmarks?.error || "";
  const shortcutPage = document.querySelector("#shortcut-page");
  const openShortcutsButton = document.querySelector("#open-shortcuts");
  const closeShortcutsButton = document.querySelector("#close-shortcuts");
  const initialSettings = window.dpaneInitialViewSettings;
  if (initialSettings) {
    scaleInput.value = String(initialSettings.scale);
    scaleValue.textContent = `${initialSettings.scale}%`;
    hiddenEntriesInput.checked = initialSettings.showHiddenEntries;
    shortcutHintsInput.checked = initialSettings.showShortcutHints;
    startupPaneCountInput.value = String(initialSettings.startupPaneCount);
  }
  let showHiddenEntries = hiddenEntriesInput.checked;
  let showShortcutHints = shortcutHintsInput.checked;
  const startupPaneCount = Number(startupPaneCountInput.value);
  let nextPaneId = 1;
  let layout;
  let activePane;
  let paneDrag = null;
  const initialPaneIds = new Set(Array.from({ length: startupPaneCount }, (_value, index) => String(index + 1)));
  const pendingInitialListings = window.dpaneStartupTiming ? new Set(initialPaneIds) : null;
  const initialReplyRequests = window.dpaneStartupReply ? new Set(initialPaneIds) : null;

  function markInitialListingRendered(paneId) {
    if (!pendingInitialListings || !pendingInitialListings.delete(paneId) || pendingInitialListings.size) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.webkit.messageHandlers.startupPaint.postMessage({});
    }));
  }

  function saveViewSettings() {
    window.webkit.messageHandlers.saveViewSettings.postMessage({
      scale: Number(scaleInput.value), showHiddenEntries, showShortcutHints, startupPaneCount: Number(startupPaneCountInput.value)
    });
  }

  function matchesShortcut(event, name) {
    const parts = keybindings[name].split("+");
    const key = parts.pop();
    const eventKey = (event.key === "Tab" || event.key === "ISO_Left_Tab" || event.code === "Tab") ? "Tab"
      : (event.shiftKey && /^Digit[0-9]$/.test(event.code || "") ? event.code.slice(-1) : event.key.toUpperCase());
    return eventKey === (key === "Tab" ? key : key.toUpperCase()) &&
      !!event.ctrlKey === parts.includes("Ctrl") && (!!event.shiftKey || event.key === "ISO_Left_Tab") === parts.includes("Shift") &&
      !!event.altKey === parts.includes("Alt") && !!event.metaKey === parts.includes("Meta");
  }

  function updateShortcutLabels(statusIsDefault = new Map()) {
    document.querySelectorAll("[data-bindings]").forEach(node => {
      node.textContent = node.dataset.bindings.split(" ").map(name => keybindings[name]).join(" / ");
    });
    document.querySelector("#shortcut-menu-key").textContent = keybindings.showShortcuts;
    panes.forEach(pane => {
      pane.element.querySelector(".split-horizontal").title = `右にペインを追加 (${keybindings.splitRight})`;
      pane.element.querySelector(".split-vertical").title = `下にペインを追加 (${keybindings.splitDown})`;
      pane.element.querySelector(".toggle-times").title = `更新日時の表示切替 (${keybindings.toggleTimes})`;
      if (statusIsDefault.get(pane)) pane.status.textContent = defaultStatus(pane);
    });
  }

  function closeShortcuts() {
    shortcutPage.hidden = true;
    focusPane(activePane);
  }

  function openShortcuts() {
    helpMenu.open = false;
    shortcutPage.hidden = false;
    closeShortcutsButton.focus();
  }

  function displayPath(path) {
    return path.startsWith("/home/") ? path.replace(/^\/home\/[^/]+/, "~") : path;
  }

  function requestDirectory(pane, path, historyAction = "navigate") {
    const requestId = ++pane.directoryRequestId;
    pane.pendingDirectory = { id: requestId, historyAction };
    pane.backButton.disabled = true;
    pane.status.textContent = "読み込み中…";
    pane.status.className = "status";
    if (initialReplyRequests?.delete(pane.id)) {
      window.webkit.messageHandlers.initialDirectoryReply.postMessage({ paneId: pane.id, path, requestId })
        .then(response => window.dirGroup.receiveDirectory(response))
        .catch(() => window.dirGroup.receiveDirectory({ paneId: pane.id, requestId, error: "一覧を取得できませんでした。" }));
      return;
    }
    window.webkit.messageHandlers.directoryListing.postMessage({ paneId: pane.id, path, requestId });
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

  function requestOpen(pane, path, choose = false, setDefault = false) {
    pane.status.textContent = "ファイルを開いています…";
    pane.status.className = "status";
    window.webkit.messageHandlers.fileOpen.postMessage({ paneId: pane.id, path, choose, setDefault });
  }

  function fileAction(pane, action) {
    const [entry] = selectedEntries(pane);
    if (selectedEntries(pane).length !== 1 || entry.directory) return;
    const path = `${pane.path}/${entry.name}`;
    if (action === "execute") {
      pane.status.textContent = "実行するファイルを確認しています…";
      pane.status.className = "status";
      window.webkit.messageHandlers.fileExecute.postMessage({ paneId: pane.id, path });
    } else requestOpen(pane, path, action === "choose", action === "set_default");
  }

  function fileOperation(pane, action) {
    const usesFolder = ["paste", "new_folder", "new_file"].includes(action);
    const entries = selectedEntries(pane);
    if (!usesFolder && !entries.length) return;
    if (action === "rename" && entries.length !== 1) return;
    const request = { paneId: pane.id, action, path: pane.path };
    if (!usesFolder) request.paths = entries.map(entry => `${pane.path}/${entry.name}`);
    pane.status.textContent = "ファイル操作を処理しています…";
    pane.status.className = "status";
    window.webkit.messageHandlers.fileOperation.postMessage(request);
  }

  const menu = document.createElement("div");
  menu.className = "file-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  for (const [label, action] of [["開く", "open"], ["別のアプリで開く", "choose"], ["既定のアプリを変更", "set_default"], ["実行", "execute"], ["名前を変更", "rename"], ["新しいフォルダ", "new_folder"], ["新しいファイル", "new_file"]]) {
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
    if (index >= 0 && !pane.selectedNames.has(pane.entries[index].name)) selectEntry(pane, index, false);
    focusPane(pane);
    const selected = selectedEntries(pane);
    const isFile = selected.length === 1 && !selected[0].directory;
    menu.querySelectorAll("button").forEach(button => {
      const action = button.dataset.action;
      button.hidden = action === "rename" ? selected.length !== 1 : !action.startsWith("new_") && !isFile;
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
    visiblePanes().forEach((pane, index) => {
      pane.element.querySelector(".pane-title").textContent = `Pane ${index + 1}`;
    });
    updateAddButtons();
  }

  function addPane(direction, source = activePane, path = source?.path, load = true) {
    if (!source || !panes.has(source.id) || panes.size >= MAX_PANES) return;
    const pane = makePane(path, false, load);
    layout = replacePane(layout, source, splitNode({ pane: source }, { pane }, direction));
    renderLayout();
    focusPane(pane);
    return pane;
  }

  function updateBookmarkButtons() {
    panes.forEach(pane => {
      if (!pane.bookmarkButton) return;
      const registered = bookmarkPaths.includes(pane.path);
      pane.bookmarkButton.textContent = registered ? "★" : "☆";
      pane.bookmarkButton.setAttribute("aria-label", registered ? "ブックマークを解除" : "ブックマークに登録");
      pane.bookmarkButton.title = registered ? "ブックマークを解除" : "ブックマークに登録";
    });
  }

  const bookmarkContext = document.createElement("div");
  bookmarkContext.className = "bookmark-context";
  bookmarkContext.hidden = true;
  document.body.append(bookmarkContext);

  function closeBookmarks() {
    bookmarkPopup.hidden = true;
    bookmarkContext.hidden = true;
    bookmarkButton.setAttribute("aria-expanded", "false");
  }

  function openBookmark(path, pane, newPane = false) {
    if (!pane || !panes.has(pane.id)) return;
    if (newPane && panes.size >= MAX_PANES) return;
    closeBookmarks();
    let requestId;
    if (!newPane) {
      requestId = ++pane.directoryRequestId;
      pane.pendingDirectory = { id: requestId, historyAction: "navigate" };
      pane.backButton.disabled = true;
    }
    window.webkit.messageHandlers.bookmarks.postMessage({ action: "open", path, paneId: pane.id, newPane, requestId });
  }

  function showBookmarkContext(event, path) {
    event.preventDefault();
    bookmarkContext.replaceChildren();
    const addAction = (label, action, disabled = false) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener("click", action);
      bookmarkContext.append(button);
      return button;
    };
    addAction("開く", () => openBookmark(path, activePane));
    addAction("新規ペインで開く", () => openBookmark(path, activePane, true), panes.size >= MAX_PANES);
    const send = document.createElement("div");
    send.className = "bookmark-send";
    const sendButton = document.createElement("button");
    sendButton.textContent = "送る ▶";
    sendButton.disabled = !panes.size;
    const submenu = document.createElement("div");
    submenu.className = "bookmark-submenu";
    visiblePanes().forEach((pane, index) => {
      const item = document.createElement("button");
      item.textContent = `Pane ${index + 1}`;
      item.addEventListener("click", () => openBookmark(path, pane));
      submenu.append(item);
    });
    send.append(sendButton, submenu);
    bookmarkContext.append(send);
    addAction("ブックマークを削除", () => {
      bookmarkContext.hidden = true;
      window.webkit.messageHandlers.bookmarks.postMessage({ action: "remove", path });
    });
    bookmarkContext.hidden = false;
    bookmarkContext.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - bookmarkContext.offsetWidth))}px`;
    bookmarkContext.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - bookmarkContext.offsetHeight))}px`;
    submenu.classList.toggle("opens-left", event.clientX + bookmarkContext.offsetWidth + 170 > window.innerWidth);
    submenu.classList.toggle("opens-up", event.clientY + panes.size * 35 > window.innerHeight);
  }

  function renderBookmarks() {
    bookmarkPopup.replaceChildren();
    if (bookmarkError || !bookmarkPaths.length) {
      const message = document.createElement("p");
      message.textContent = bookmarkError || "ブックマークはありません。";
      bookmarkPopup.append(message);
    }
    bookmarkPaths.forEach(path => {
      const row = document.createElement("div");
      row.className = "bookmark-row";
      row.addEventListener("contextmenu", event => showBookmarkContext(event, path));
      const open = document.createElement("button");
      open.className = "bookmark-open";
      open.textContent = `📁 ${path.split("/").filter(Boolean).pop() || "/"}`;
      open.title = path;
      open.addEventListener("click", () => openBookmark(path, activePane));
      const add = document.createElement("button");
      add.textContent = "⊞";
      add.title = "新規ペインで開く";
      add.disabled = panes.size >= MAX_PANES;
      add.addEventListener("click", () => openBookmark(path, activePane, true));
      row.append(open, add);
      bookmarkPopup.append(row);
    });
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

  function selectedEntries(pane) {
    return pane.entries.filter(entry => pane.selectedNames.has(entry.name));
  }

  function defaultStatus(pane) {
    const selected = pane.selectedNames.size ? ` · ${pane.selectedNames.size} 件選択` : "";
    const hints = showShortcutHints ? ` · ↑↓ / Enter / Backspace / F5 · ${keybindings.nextPane} / ${Array.from({ length: MAX_PANES }, (_, index) => keybindings[`pane${index + 1}`]).join(" / ")}` : "";
    return `${pane.entries.length} 件${pane.truncated ? "（取得上限 1,000 件）" : ""}${selected}${hints}`;
  }

  function updateSelection(pane, scroll = true) {
    const buttons = [...pane.list.querySelectorAll(".entry")];
    buttons.forEach((button, index) => button.classList.toggle("selected", pane.selectedNames.has(pane.entries[index].name)));
    if (scroll && pane.selectedIndex >= 0 && buttons[pane.selectedIndex]) {
      buttons[pane.selectedIndex].scrollIntoView({ block: "nearest" });
    }
    if (pane.status?.className === "status") pane.status.textContent = defaultStatus(pane);
  }

  function selectRange(pane, index, scroll = true) {
    const anchor = pane.selectionAnchor >= 0 ? pane.selectionAnchor : (pane.selectedIndex >= 0 ? pane.selectedIndex : index);
    pane.selectedNames.clear();
    for (let item = Math.min(anchor, index); item <= Math.max(anchor, index); item++) {
      pane.selectedNames.add(pane.entries[item].name);
    }
    pane.selectionAnchor = anchor;
    pane.selectedIndex = index;
    updateSelection(pane, scroll);
  }

  function selectEntry(pane, index, scroll = true, event = null) {
    if (index < 0 || index >= pane.entries.length) return;
    if (event?.shiftKey) {
      selectRange(pane, index, scroll);
      return;
    } else if (event?.ctrlKey) {
      const name = pane.entries[index].name;
      if (pane.selectedNames.has(name)) pane.selectedNames.delete(name);
      else pane.selectedNames.add(name);
      pane.selectionAnchor = pane.selectedNames.size ? index : -1;
    } else {
      pane.selectedNames = new Set([pane.entries[index].name]);
      pane.selectionAnchor = index;
    }
    pane.selectedIndex = pane.selectedNames.size ? index : -1;
    updateSelection(pane, scroll);
  }

  function moveSelection(pane, offset, extend = false) {
    if (!pane.entries.length) return;
    const current = pane.selectedIndex >= 0 ? pane.selectedIndex : (offset > 0 ? -1 : pane.entries.length);
    const next = Math.max(0, Math.min(current + offset, pane.entries.length - 1));
    selectEntry(pane, next, true, extend ? { shiftKey: true } : null);
  }

  function setupEntryDrag(button, pane, index) {
    button.draggable = true;
    button.addEventListener("dragstart", event => {
      if (!event.dataTransfer) {
        event.preventDefault();
        return;
      }
      if (!pane.selectedNames.has(pane.entries[index].name)) selectEntry(pane, index, false);
      const paths = selectedEntries(pane).map(entry => `${pane.path.replace(/\/$/, "")}/${entry.name}`);
      const uris = paths.map(path => `file://${path.split("/").map(encodeURIComponent).join("/")}`);
      paneDrag = { source: pane, paths };
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/uri-list", uris.join("\r\n"));
      if (paths.length > 1) {
        const image = document.createElement("div");
        image.className = "entry-icon folder-icon drag-image";
        document.body.append(image);
        event.dataTransfer.setDragImage(image, 10, 10);
        requestAnimationFrame(() => image.remove());
      }
    });
    button.addEventListener("dragend", () => { paneDrag = null; });
  }

  function setupBlankSelection(pane) {
    let selection = null;
    let suppressClick = false;
    pane.list.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target !== pane.list) return;
      suppressClick = false;
      selection = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, box: null };
      pane.list.setPointerCapture(event.pointerId);
    });
    pane.list.addEventListener("pointermove", event => {
      if (!selection || event.pointerId !== selection.pointerId) return;
      if (!selection.box && Math.hypot(event.clientX - selection.x, event.clientY - selection.y) < 4) return;
      if (!selection.box) {
        selection.box = document.createElement("div");
        selection.box.className = "selection-box";
        document.body.append(selection.box);
      }
      const bounds = pane.list.getBoundingClientRect();
      const x = Math.max(bounds.left, Math.min(bounds.right, event.clientX));
      const y = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY));
      const left = Math.min(selection.x, x), right = Math.max(selection.x, x);
      const top = Math.min(selection.y, y), bottom = Math.max(selection.y, y);
      Object.assign(selection.box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      const buttons = [...pane.list.querySelectorAll(".entry")];
      pane.selectedNames.clear();
      buttons.forEach((button, index) => {
        const rect = button.getBoundingClientRect();
        if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) pane.selectedNames.add(pane.entries[index].name);
      });
      pane.selectedIndex = buttons.findIndex((_button, index) => pane.selectedNames.has(pane.entries[index].name));
      pane.selectionAnchor = pane.selectedIndex;
      updateSelection(pane, false);
    });
    const finish = event => {
      if (!selection || event.pointerId !== selection.pointerId) return;
      suppressClick = !!selection.box;
      selection.box?.remove();
      selection = null;
      if (pane.list.hasPointerCapture(event.pointerId)) pane.list.releasePointerCapture(event.pointerId);
    };
    pane.list.addEventListener("pointerup", finish);
    pane.list.addEventListener("pointercancel", finish);
    pane.list.addEventListener("lostpointercapture", finish);
    pane.list.addEventListener("click", event => {
      if (suppressClick) { suppressClick = false; return; }
      if (event.target !== pane.list || event.button !== 0) return;
      pane.selectedNames.clear();
      pane.selectedIndex = pane.selectionAnchor = -1;
      updateSelection(pane, false);
    });
  }

  function formatModified(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return "—";
    const two = value => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  function toggleModifiedTimes(pane) {
    pane.showModified = !pane.showModified;
    pane.timeButton.setAttribute("aria-pressed", String(pane.showModified));
    pane.list.querySelectorAll(".entry").forEach((button, index) => {
      updateEntryTimestamp(button, pane.entries[index], pane.showModified);
    });
  }

  function updateEntryTimestamp(button, entry, show) {
    const existing = button.querySelector(".entry-time");
    if (!show) { if (existing) existing.remove(); return; }
    const modified = existing || document.createElement("span");
    modified.className = "entry-time";
    modified.textContent = formatModified(entry.modified);
    if (!existing) button.append(modified);
  }

  function activateSelectedEntry(pane) {
    const [entry] = selectedEntries(pane);
    if (selectedEntries(pane).length !== 1) return;
    const path = `${pane.path}/${entry.name}`;
    if (entry.directory) requestDirectory(pane, path);
    else requestOpen(pane, path);
  }

  function handlePaneKeydown(event) {
    if (!activePane) return;
    if (!shortcutPage.hidden) {
      if (!event.isComposing && (event.key === "Escape" || matchesShortcut(event, "showShortcuts"))) {
        event.preventDefault();
        closeShortcuts();
      }
      return;
    }
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
    if (event.isComposing) return;
    if (matchesShortcut(event, "showShortcuts")) {
      event.preventDefault(); openShortcuts(); return;
    }
    for (const [name, action] of [["splitRight", () => addPane("horizontal")], ["splitDown", () => addPane("vertical")], ["closePane", () => closePane()]]) {
      if (matchesShortcut(event, name)) { event.preventDefault(); action(); return; }
    }
    if (matchesShortcut(event, "toggleTimes") && (event.target === document.body || event.target.closest("#workspace"))) {
      event.preventDefault(); toggleModifiedTimes(activePane); return;
    }
    for (const [name, offset] of [["nextPane", 1], ["previousPane", -1]]) {
      if (matchesShortcut(event, name)) { event.preventDefault(); moveActivePane(offset); return; }
    }
    for (let number = 1; number <= MAX_PANES; number++) {
      if (matchesShortcut(event, `pane${number}`)) { event.preventDefault(); focusPaneByNumber(number); return; }
    }
    if (event.target === activePane.input || (!event.target.closest("#workspace") && event.target !== document.body)) return;
    for (const [name, action] of [["chooseApplication", "choose"], ["execute", "execute"]]) {
      if (matchesShortcut(event, name)) { event.preventDefault(); menu.hidden = true; fileAction(activePane, action); return; }
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && ["c", "x", "v"].includes(event.key.toLowerCase())) {
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
    else if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(activePane, 1, event.shiftKey); }
    else if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(activePane, -1, event.shiftKey); }
    else if (event.key === "Enter") { event.preventDefault(); activateSelectedEntry(activePane); }
    else if (event.key === "Backspace") {
      event.preventDefault();
      activePane.element.querySelector(".up").click();
    } else if (event.key === "F5") {
      event.preventDefault();
      requestDirectory(activePane, activePane.path);
    }
  }

  function makePane(path, selectInitial = true, load = true) {
    const id = String(nextPaneId++);
    const element = document.createElement("section");
    element.className = "pane";
    element.dataset.paneId = id;
    const pane = { id, element, path, entries: [], allEntries: [], selectedNames: new Set(), selectedIndex: -1,
      selectionAnchor: -1, selectInitial, showModified: false, history: [], hasLocation: false, directoryRequestId: 0 };
    element.innerHTML = `
      <div class="pane-header"><span class="pane-title">Pane ${id}</span>
        <button class="back" title="前のフォルダへ戻る" aria-label="前のフォルダへ戻る" disabled>←</button>
        <button class="up" title="親フォルダへ">↑</button>
        <button class="bookmark-toggle" title="ブックマークに登録" aria-label="ブックマークに登録">☆</button>
        <input class="path" aria-label="フォルダのパス">
        <button class="split-horizontal" title="右にペインを追加 (${keybindings.splitRight})" aria-label="右にペインを追加">||</button>
        <button class="split-vertical" title="下にペインを追加 (${keybindings.splitDown})" aria-label="下にペインを追加">＝</button>
        <button class="close-pane" title="このペインを閉じる" aria-label="このペインを閉じる">×</button>
        </div><div class="status-row"><p class="status">準備中…</p>
        <button class="toggle-times" aria-pressed="false" title="更新日時の表示切替 (${keybindings.toggleTimes})">Update times</button>
        </div><div class="entry-list"></div>`;
    pane.input = element.querySelector(".path");
    pane.backButton = element.querySelector(".back");
    pane.backButton.disabled = true;
    pane.backButton.addEventListener("click", () => {
      if (pane.history.length && !pane.pendingDirectory) requestDirectory(pane, pane.history[pane.history.length - 1], "back");
    });
    pane.bookmarkButton = element.querySelector(".bookmark-toggle");
    pane.bookmarkButton.addEventListener("click", () => {
      const registered = bookmarkPaths.includes(pane.path);
      window.webkit.messageHandlers.bookmarks.postMessage({ action: registered ? "remove" : "add", path: pane.path });
    });
    setupCompletion(pane);
    pane.status = element.querySelector(".status");
    pane.timeButton = element.querySelector(".toggle-times");
    pane.timeButton.addEventListener("click", () => toggleModifiedTimes(pane));
    pane.list = element.querySelector(".entry-list");
    setupBlankSelection(pane);
    element.addEventListener("dragover", event => {
      if (!paneDrag || !panes.has(paneDrag.source.id)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = paneDrag.source === pane ? "none" : "copy";
    });
    element.addEventListener("drop", event => {
      if (!paneDrag || !panes.has(paneDrag.source.id)) return;
      event.preventDefault();
      if (paneDrag.source === pane) return;
      const paths = paneDrag.paths;
      paneDrag = null;
      pane.status.textContent = "ファイル操作を処理しています…";
      pane.status.className = "status";
      window.webkit.messageHandlers.fileOperation.postMessage({ paneId: pane.id, action: "drag_copy", path: pane.path, paths });
    });
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
    pane.input.addEventListener("pointerdown", event => {
      if (event.button !== 0 || document.activeElement === pane.input) return;
      event.preventDefault();
      pane.input.focus();
      pane.input.setSelectionRange(0, pane.input.value.length);
    });
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
    if (load) requestDirectory(pane, pane.path);
    updateBookmarkButtons();
    return pane;
  }

  function renderEntries(pane, selectedNames = pane.selectedNames, selectFirst = false) {
    const cursorName = pane.entries[pane.selectedIndex]?.name;
    pane.entries = pane.allEntries.filter(entry => showHiddenEntries || !entry.name.startsWith("."));
    const available = new Set(pane.entries.map(entry => entry.name));
    pane.selectedNames = new Set([...selectedNames].filter(name => available.has(name)));
    pane.selectedIndex = pane.entries.findIndex(entry => entry.name === cursorName);
    if (pane.selectedIndex < 0) pane.selectedIndex = pane.entries.findIndex(entry => pane.selectedNames.has(entry.name));
    if (!pane.selectedNames.size && selectFirst && pane.entries.length) {
      pane.selectedNames.add(pane.entries[0].name);
      pane.selectedIndex = 0;
    }
    pane.selectionAnchor = pane.selectedIndex;
    pane.list.replaceChildren(...pane.entries.map((entry, index) => {
      const button = document.createElement("button");
      button.className = "entry";
      button.innerHTML = `<span class="entry-icon ${entry.directory ? "folder-icon" : "file-icon"}" aria-hidden="true"></span><span class="entry-name"></span>`;
      button.querySelector(".entry-name").textContent = entry.name;
      updateEntryTimestamp(button, entry, pane.showModified);
      setupEntryDrag(button, pane, index);
      button.addEventListener("click", event => selectEntry(pane, index, false, event));
      button.addEventListener("dblclick", () => activateSelectedEntry(pane));
      return button;
    }));
    updateSelection(pane, false);
  }

  window.dirGroup = {
    receiveDirectories(responses) {
      responses.forEach(response => window.dirGroup.receiveDirectory(response));
    },
    receiveDirectory(response) {
      const pane = panes.get(response.paneId);
      if (!pane) return;
      if (response.requestId !== undefined && response.requestId !== pane.directoryRequestId) return;
      const pending = pane.pendingDirectory;
      pane.pendingDirectory = null;
      pane.backButton.disabled = !pane.history.length;
      const measuring = pendingInitialListings?.has(response.paneId);
      const renderStarted = measuring ? performance.now() : 0;
      if (measuring) reportStartup("list-receive", { paneId: response.paneId, readyState: document.readyState });
      const preserveInput = document.activeElement === pane.input &&
        (pane.submittingPath === undefined || pane.input.value !== pane.submittingPath);
      pane.submittingPath = undefined;
      if (response.error) {
        pane.status.textContent = response.error;
        pane.status.className = "status error";
        if (pane === activePane && !preserveInput) focusPane(pane);
        if (measuring) reportStartup("list-render", { paneId: response.paneId, count: 0, duration: performance.now() - renderStarted });
        markInitialListingRendered(response.paneId);
        return;
      }
      const pathChanged = pane.path !== response.path;
      if (pane.hasLocation && pathChanged) {
        if (pending?.historyAction === "back") pane.history.pop();
        else pane.history.push(pane.path);
      }
      pane.path = response.path;
      pane.hasLocation = true;
      pane.backButton.disabled = !pane.history.length;
      updateBookmarkButtons();
      pane.allEntries = response.entries;
      pane.truncated = response.truncated;
      let selectedNames = pathChanged ? new Set() : pane.selectedNames;
      if (pane.pendingSelection) {
        if (response.path === pane.pendingSelection.directory) {
          selectedNames = new Set(pane.pendingSelection.names);
        }
        pane.pendingSelection = null;
      }
      renderEntries(pane, selectedNames, !selectedNames.size && pane.selectInitial);
      pane.selectInitial = true;
      if (!preserveInput) pane.input.value = displayPath(response.path);
      pane.status.textContent = defaultStatus(pane);
      pane.status.className = "status";
      if (pane.operationNotice) {
        pane.status.textContent = pane.operationNotice.text;
        pane.status.className = pane.operationNotice.error ? "status error" : "status";
        pane.operationNotice = null;
      }
      if (pane === activePane && !preserveInput) focusPane(pane);
      if (measuring) reportStartup("list-render", { paneId: response.paneId, count: pane.entries.length, duration: performance.now() - renderStarted });
      markInitialListingRendered(response.paneId);
    },
    receiveKeybindingsReset(response) {
      if (response.error) { window.alert(response.error); return; }
      const statusIsDefault = new Map([...panes.values()].map(pane => [pane, pane.status.textContent === defaultStatus(pane)]));
      keybindings = response.bindings;
      updateShortcutLabels(statusIsDefault);
    },
    receiveBookmarks(response) {
      if (response.action === "open" && !response.newPane && response.requestId !== undefined) {
        const pane = panes.get(response.paneId);
        if (!pane || response.requestId !== pane.directoryRequestId) return;
        if (response.error) {
          pane.pendingDirectory = null;
          pane.backButton.disabled = !pane.history.length;
        }
      }
      if (response.error) {
        bookmarkError = response.error;
        renderBookmarks();
        bookmarkPopup.hidden = false;
        bookmarkButton.setAttribute("aria-expanded", "true");
        return;
      }
      bookmarkError = "";
      if (response.paths) {
        bookmarkPaths = response.paths;
        updateBookmarkButtons();
        renderBookmarks();
      } else if (response.action === "open") {
        let pane = panes.get(response.paneId);
        if (response.newPane) {
          pane = addPane("horizontal", pane, response.path, false);
          delete response.requestId;
        }
        if (!pane) return;
        window.dirGroup.receiveDirectory({ ...response, paneId: pane.id });
        focusPane(pane);
      }
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
      if (pane && response.selectedNames && pane.path === response.selectedDirectory) {
        pane.pendingSelection = { names: response.selectedNames, directory: response.selectedDirectory };
      }
      if (pane && response.refresh) pane.operationNotice = { text: response.error || response.message, error: !!response.error };
      if (response.refresh) panes.forEach(item => requestDirectory(item, item.path));
      if (!pane) return;
      pane.status.textContent = response.error || response.message;
      pane.status.className = response.error ? "status error" : "status";
      if (pane === activePane && document.activeElement !== pane.input) focusPane(pane);
    }
  };

  const initial = defaultPaths.slice(0, startupPaneCount).map(path => makePane(path));
  if (startupPaneCount === 1) layout = { pane: initial[0] };
  else if (startupPaneCount === 2) layout = splitNode({ pane: initial[0] }, { pane: initial[1] }, "horizontal");
  else if (startupPaneCount === 3) layout = splitNode({ pane: initial[0] }, splitNode({ pane: initial[1] }, { pane: initial[2] }, "vertical"), "horizontal");
  else layout = splitNode(splitNode({ pane: initial[0] }, { pane: initial[1] }, "vertical"),
                          splitNode({ pane: initial[2] }, { pane: initial[3] }, "vertical"), "horizontal");
  renderLayout();
  focusPane(initial[0]);
  updateShortcutLabels();
  if (window.dpaneKeybindingsError) setTimeout(() => window.alert(window.dpaneKeybindingsError), 0);
  reportStartup("initial-layout");
  document.addEventListener("keydown", handlePaneKeydown, true);
  bookmarkButton.addEventListener("click", () => {
    const opening = bookmarkPopup.hidden;
    closeBookmarks();
    if (opening) {
      viewMenu.open = false;
      helpMenu.open = false;
      settingsMenu.open = false;
      renderBookmarks();
      bookmarkPopup.hidden = false;
      bookmarkButton.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener("click", event => {
    if (!bookmarkPopup.contains(event.target) && !bookmarkButton.contains(event.target) && !bookmarkContext.contains(event.target)) closeBookmarks();
    if (!settingsMenu.contains(event.target)) settingsMenu.open = false;
    if (!helpMenu.contains(event.target)) helpMenu.open = false;
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") closeBookmarks(); });
  viewMenu.addEventListener("toggle", () => {
    if (viewMenu.open) { helpMenu.open = false; settingsMenu.open = false; closeBookmarks(); }
  });
  helpMenu.addEventListener("toggle", () => {
    if (helpMenu.open) { viewMenu.open = false; settingsMenu.open = false; closeBookmarks(); }
  });
  settingsMenu.addEventListener("toggle", () => {
    if (settingsMenu.open) { viewMenu.open = false; helpMenu.open = false; closeBookmarks(); }
  });
  document.querySelector("#reset-keybindings").addEventListener("click", () => {
    settingsMenu.open = false;
    window.webkit.messageHandlers.resetKeybindings.postMessage({});
  });
  openShortcutsButton.addEventListener("click", () => {
    openShortcuts();
  });
  closeShortcutsButton.addEventListener("click", closeShortcuts);
  scaleInput.addEventListener("input", () => {
    const percent = Number(scaleInput.value);
    scaleValue.textContent = `${percent}%`;
    window.webkit.messageHandlers.uiScale.postMessage({ percent });
    saveViewSettings();
  });
  startupPaneCountInput.addEventListener("change", saveViewSettings);
  hiddenEntriesInput.addEventListener("change", () => {
    showHiddenEntries = hiddenEntriesInput.checked;
    panes.forEach(pane => {
      renderEntries(pane, pane.selectedNames);
      pane.status.textContent = defaultStatus(pane);
      pane.status.className = "status";
    });
    saveViewSettings();
  });
  shortcutHintsInput.addEventListener("change", () => {
    const statusIsDefault = new Map([...panes.values()].map(pane => [pane, pane.status.textContent === defaultStatus(pane)]));
    showShortcutHints = shortcutHintsInput.checked;
    panes.forEach(pane => {
      if (statusIsDefault.get(pane)) pane.status.textContent = defaultStatus(pane);
    });
    saveViewSettings();
  });
})();
