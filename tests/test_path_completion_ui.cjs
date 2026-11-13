const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(tag = "div") {
    const customProperties = new Map();
    this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = new Proxy({
      setProperty(name, value) { customProperties.set(name, value); },
      getPropertyValue(name) { return customProperties.get(name) || ""; }
    }, { set(target, name, value) { if (String(name).startsWith("--")) throw new Error("Use setProperty for custom CSS properties"); target[name] = value; return true; } });
    this.hidden = false;
    this.value = ""; this.selectionStart = this.selectionEnd = 0; this.className = ""; this.attributes = {};
    const classes = new Set();
    this.classList = {
      toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; },
      add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    };
  }
  set innerHTML(value) {
    this.parts = {};
    for (const name of ["path", "status", "entry-list", "up", "back", "close-pane", "minimize-pane", "maximize-pane", "split-horizontal", "split-vertical", "entry-name", "toggle-times", "bookmark-toggle", "pane-title"]) {
      if (value.includes(name)) { this.parts[name] = new Element(); this.parts[name].parent = this; }
    }
  }
  querySelector(selector) { return this.parts?.[selector === "summary" ? selector : selector.slice(1)] || this.children.find(child => selector === "button" ? child.tag === "button" : child.className === selector.slice(1)) || null; }
  querySelectorAll(selector) {
    if (selector === ".split-horizontal, .split-vertical") return [this.parts?.["split-horizontal"], this.parts?.["split-vertical"]].filter(Boolean);
    return selector === "button" ? this.children : this.children.filter(child => child.className === selector.slice(1));
  }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = value; }
  setPointerCapture(pointerId) { this.pointerId = pointerId; }
  hasPointerCapture(pointerId) { return this.pointerId === pointerId; }
  releasePointerCapture(pointerId) { if (this.pointerId === pointerId) this.pointerId = null; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, bottom: 20, width: 200 }; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  closest(selector) { let node = this; while (node) { if (selector === "#workspace" && node === workspace) return node; if (selector === ".entry" && node.className === "entry") return node; node = node.parent; } return null; }
  fire(name, props = {}) {
    const event = { target: this, key: "", preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
    for (const fn of this.events[name] || []) { fn(event); if (event.stopped) break; }
    return event;
  }
}

const workspace = new Element("main");
const ids = { "#workspace": workspace, "#ui-scale": new Element(), "#ui-scale-value": new Element(), "#show-hidden-entries": new Element(), "#show-shortcut-hints": new Element(), "#startup-pane-count": new Element(), "#pane-bar": new Element(), ".view-menu": new Element(), ".help-menu": new Element(), ".settings-menu": new Element(), "#reset-keybindings": new Element(), "#shortcut-menu-key": new Element(), "#shortcut-page": new Element(), "#open-shortcuts": new Element(), "#close-shortcuts": new Element(), "#bookmark-menu-button": new Element(), "#bookmark-popup": new Element() };
ids["#bookmark-popup"].hidden = true;
ids["#show-hidden-entries"].checked = true;
ids["#show-shortcut-hints"].checked = true;
ids["#ui-scale"].value = "100";
ids["#startup-pane-count"].value = "3";
ids["#shortcut-page"].hidden = true;
const document = { body: new Element("body"), activeElement: null, events: {}, readyState: "loading", pointTarget: null, querySelector: id => ids[id], querySelectorAll: () => [], createElement: tag => new Element(tag), elementFromPoint() { return this.pointTarget; }, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
const calls = [], directoryCalls = [], closeCalls = [], scaleCalls = [], operationCalls = [], settingsCalls = [], paintCalls = [], detailCalls = [];
const bookmarkCalls = [], resetCalls = [];
const alerts = [];
const window = { alert: message => alerts.push(message), dpaneKeybindings: { splitRight: "Ctrl+Shift+L", splitDown: "Ctrl+Shift+J", closePane: "Ctrl+Shift+W", toggleTimes: "Ctrl+T", showShortcuts: "Ctrl+K", nextPane: "Ctrl+Tab", previousPane: "Ctrl+Shift+Tab", pane1: "Alt+1", pane2: "Alt+2", pane3: "Alt+3", pane4: "Alt+4", pane5: "Alt+5", pane6: "Alt+6", pane7: "Alt+7", pane8: "Alt+8", chooseApplication: "Ctrl+Shift+O", execute: "Ctrl+Shift+E" }, innerWidth: 1200, innerHeight: 800, events: {}, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }, webkit: { messageHandlers: { bookmarks: { postMessage: value => bookmarkCalls.push(value) }, directoryListing: { postMessage: value => directoryCalls.push(value) }, pathCompletion: { postMessage: value => calls.push(value) }, closeWindow: { postMessage: value => closeCalls.push(value) }, uiScale: { postMessage: value => scaleCalls.push(value) }, saveViewSettings: { postMessage: value => settingsCalls.push(value) }, fileOperation: { postMessage: value => operationCalls.push(value) }, startupPaint: { postMessage: value => paintCalls.push(value) }, startupDetail: { postMessage: value => detailCalls.push(value) } } } };
const openCalls = [];
window.webkit.messageHandlers.resetKeybindings = { postMessage: value => resetCalls.push(value) };
window.webkit.messageHandlers.fileOpen = { postMessage: value => openCalls.push(value) };
const timers = new Map(); let nextTimer = 0;
const setTimeout = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
const clearTimeout = id => timers.delete(id);
const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), { window, document, performance, setTimeout, clearTimeout, requestAnimationFrame: fn => fn() });
const find = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...node.children.flatMap(child => find(child, predicate)) ];
const pane = find(workspace, node => node.className === "pane")[0];
const input = pane.querySelector(".path");
input.value = "/home/test";
const firstPathClick = input.fire("pointerdown", { button: 0 });
assert.equal(firstPathClick.prevented, true);
assert.strictEqual(document.activeElement, input);
assert.equal(input.selectionStart, 0);
assert.equal(input.selectionEnd, input.value.length);
const secondPathClick = input.fire("pointerdown", { button: 0 });
assert.equal(secondPathClick.prevented, undefined);
input.focus();
function type(value, cursor = value.length) { input.value = value; input.setSelectionRange(cursor, cursor); input.fire("input"); }
function reply(request, candidates, common, count = candidates.length) { window.dirGroup.receivePathCompletion({ paneId: request.paneId, requestId: request.requestId, candidates, common, count }); }
function dropdown() { return document.body.children.find(node => node.className === "path-completions"); }

type("~/Do"); flush();
const stale = calls.at(-1);
type("~/Doc"); flush();
const current = calls.at(-1);
reply(stale, ["Downloads"], "Downloads");
assert(dropdown().hidden);
reply(current, ["Documents"], "Documents");
assert(!dropdown().hidden);
assert(input.fire("keydown", { key: "Tab" }).prevented);
assert.equal(input.value, "~/Documents/");

type("~/Do"); flush();
reply(calls.at(-1), ["Documents", "Downloads"], "Do");
input.fire("keydown", { key: "ArrowDown" });
assert(input.fire("keydown", { key: "Enter" }).prevented);
assert.equal(input.value, "~/Documents/");

type("~/Do");
assert(input.fire("keydown", { key: "Tab" }).prevented);
const immediate = calls.at(-1);
reply(immediate, ["Documents", "Downloads"], "Do");
assert.equal(input.value, "~/Do");
assert(!dropdown().hidden);
assert(!input.fire("keydown", { key: "Tab", shiftKey: true }).prevented);

type("~/Doc/child", 5); flush();
reply(calls.at(-1), ["Documents"], "Documents");
input.fire("keydown", { key: "Tab" });
assert.equal(input.value, "~/Documents/child");

type("~/Do"); flush();
const beforeBlur = calls.at(-1);
input.fire("blur"); document.activeElement = document.body;
reply(beforeBlur, ["Documents"], "Documents");
assert(dropdown().hidden);

input.focus(); type("~/Doc"); flush();
const beforeEscape = calls.at(-1);
assert(input.fire("keydown", { key: "Escape" }).prevented);
reply(beforeEscape, ["Documents"], "Documents");
assert(dropdown().hidden);

input.focus(); type("~/unfinished");
window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [] });
assert.equal(input.value, "~/unfinished");
assert.strictEqual(document.activeElement, input);
input.fire("keydown", { key: "Enter" });
assert.equal(directoryCalls.at(-1).path, "~/unfinished");
pane.querySelector(".up").fire("click");
assert.equal(directoryCalls.at(-1).path, "/home/test/..");
ids["#ui-scale"].value = "130";
ids["#ui-scale"].fire("input");
assert.equal(scaleCalls.at(-1).percent, 130);
assert.equal(ids["#ui-scale-value"].textContent, "130%");
assert.equal(settingsCalls.at(-1).scale, 130);
ids["#startup-pane-count"].value = "4";
ids["#startup-pane-count"].fire("change");
assert.equal(settingsCalls.at(-1).startupPaneCount, 4);

ids["#open-shortcuts"].fire("click");
assert(!ids["#shortcut-page"].hidden);
ids["#close-shortcuts"].fire("click");
assert(ids["#shortcut-page"].hidden);
const openShortcut = { target: input, key: "k", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
  preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(openShortcut);
assert(openShortcut.prevented);
assert(!ids["#shortcut-page"].hidden);
const toggleShortcut = { target: ids["#close-shortcuts"], key: "k", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(toggleShortcut);
assert(toggleShortcut.prevented);
assert(ids["#shortcut-page"].hidden);
for (const handler of document.events.keydown) handler(openShortcut);
const closeShortcut = { target: ids["#close-shortcuts"], key: "Escape", preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(closeShortcut);
assert(closeShortcut.prevented);
assert(ids["#shortcut-page"].hidden);
ids[".help-menu"].open = true;
ids[".view-menu"].open = true;
ids[".view-menu"].fire("toggle");
assert(!ids[".help-menu"].open);
ids[".view-menu"].open = true;
ids[".help-menu"].open = true;
ids[".help-menu"].fire("toggle");
assert(!ids[".view-menu"].open);
for (const menu of [ids[".settings-menu"], ids[".help-menu"]]) {
  const inside = new Element();
  menu.append(inside);
  menu.open = true;
  for (const handler of document.events.click) handler({ target: inside });
  assert(menu.open);
  for (const handler of document.events.click) handler({ target: workspace });
  assert(!menu.open);
}

window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [
  { name: ".hidden", directory: true, modified: 1700000000 }, { name: ".file", directory: false, modified: null }, { name: "visible", directory: true, modified: 1700000000 }
] });
window.dirGroup.receiveDirectory({ paneId: "2", path: "/home/other", entries: [
  { name: ".second", directory: true }, { name: ".config", directory: false }
] });
const secondPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "2")[0];
assert.equal(pane.querySelector(".entry-list").children.length, 3);
const entries = pane.querySelector(".entry-list").children;
entries[1].fire("click");
pane.querySelector(".entry-list").fire("contextmenu", { target: entries[1], clientX: 0, clientY: 0 });
const fileMenu = document.body.children.find(node => node.className === "file-menu");
fileMenu.children.find(node => node.dataset.action === "set_default").fire("click");
assert.equal(openCalls.at(-1).setDefault, true);
assert.equal(openCalls.at(-1).path, "/home/test/.file");
const list = pane.querySelector(".entry-list");
list.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 200 });
entries.forEach((entry, index) => { entry.getBoundingClientRect = () => ({ left: 0, right: 200, top: index * 30, bottom: index * 30 + 30 }); });
list.fire("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 120 });
list.fire("pointermove", { pointerId: 1, clientX: 50, clientY: 10 });
assert(document.body.children.some(node => node.className === "selection-box"));
list.fire("pointerup", { pointerId: 1 });
list.fire("click", { button: 0 });
assert(!document.body.children.some(node => node.className === "selection-box"));
pane.fire("pointerdown");
const longPressCopy = { target: pane, key: "c", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(longPressCopy);
assert.deepEqual(operationCalls.at(-1).paths, ["/home/test/.hidden", "/home/test/.file", "/home/test/visible"]);
operationCalls.length = 0;
entries[0].fire("click");
entries[2].fire("click", { ctrlKey: true });
entries[1].fire("click", { shiftKey: true });
const dragData = { values: {}, setData(type, value) { this.values[type] = value; }, setDragImage(image) { this.image = image; } };
entries[1].fire("dragstart", { dataTransfer: dragData });
assert.equal(dragData.effectAllowed, "copy");
assert.equal(dragData.image.className, "entry-icon folder-icon drag-image");
assert(!dragData.image.textContent);
assert.equal(dragData.values["text/uri-list"], "file:///home/test/.file\r\nfile:///home/test/visible");
assert(pane.fire("dragover", { dataTransfer: dragData }).prevented);
assert.equal(dragData.dropEffect, "none");
assert(pane.fire("drop", { dataTransfer: dragData }).prevented);
assert(secondPane.fire("dragover", { dataTransfer: dragData }).prevented);
assert.equal(dragData.dropEffect, "copy");
assert(secondPane.fire("drop", { dataTransfer: dragData }).prevented);
assert.equal(operationCalls.at(-1).action, "drag_copy");
assert.equal(operationCalls.at(-1).paneId, "2");
assert.equal(operationCalls.at(-1).path, "/home/other");
assert.deepEqual(operationCalls.at(-1).paths, ["/home/test/.file", "/home/test/visible"]);
assert(!secondPane.fire("drop", { dataTransfer: dragData }).prevented);
operationCalls.length = 0;
const singleDrag = { values: {}, setData(type, value) { this.values[type] = value; } };
entries[0].fire("pointerdown", { button: 0, pointerId: 5, clientX: 20, clientY: 10 });
flush();
entries[0].fire("dragstart", { dataTransfer: singleDrag });
assert.equal(singleDrag.values["text/uri-list"], "file:///home/test/.hidden");
entries[0].fire("dragend");
assert(!secondPane.fire("dragover", { dataTransfer: singleDrag }).prevented);
entries[1].fire("click");
entries[2].fire("click", { ctrlKey: true });
pane.fire("pointerdown");
const copySelection = { target: pane, key: "c", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(copySelection);
assert(copySelection.prevented);
assert.deepEqual(operationCalls.at(-1).paths, ["/home/test/.file", "/home/test/visible"]);
operationCalls.length = 0;
pane.querySelector(".entry-list").fire("click", { button: 2 });
for (const handler of document.events.keydown) handler(copySelection);
assert.deepEqual(operationCalls.at(-1).paths, ["/home/test/.file", "/home/test/visible"]);
operationCalls.length = 0;
pane.querySelector(".entry-list").fire("click", { button: 0 });
for (const handler of document.events.keydown) handler(copySelection);
assert.equal(operationCalls.length, 0);
entries[1].fire("click");
entries[2].fire("click", { ctrlKey: true });
assert.match(pane.querySelector(".status").textContent, /3 件 · 2 件選択 · ↑↓/);
ids["#show-shortcut-hints"].checked = false;
ids["#show-shortcut-hints"].fire("change");
assert.equal(pane.querySelector(".status").textContent, "3 件 · 2 件選択");
assert.equal(settingsCalls.at(-1).showShortcutHints, false);
assert.doesNotMatch(secondPane.querySelector(".status").textContent, /Ctrl\+Tab/);
window.dirGroup.receiveOpenResult({ paneId: "2", error: "テストエラー" });
entries[0].fire("click");
assert.equal(pane.querySelector(".status").textContent, "3 件 · 1 件選択");
ids["#show-shortcut-hints"].checked = true;
ids["#show-shortcut-hints"].fire("change");
assert.match(pane.querySelector(".status").textContent, /3 件 · 1 件選択 · ↑↓/);
assert.equal(secondPane.querySelector(".status").textContent, "テストエラー");
window.dirGroup.receiveDirectory({ paneId: "2", path: "/home/other", entries: [
  { name: ".second", directory: true }, { name: ".config", directory: false }
] });
assert.match(secondPane.querySelector(".status").textContent, /Ctrl\+Tab/);
entries[0].fire("click");
input.focus();
type("~/editing");
pane.querySelector(".toggle-times").fire("click");
assert.equal(pane.querySelector(".toggle-times").attributes["aria-pressed"], "true");
assert(pane.querySelector(".entry-list").classList.contains("show-modified"));
assert.match(pane.querySelector(".entry-list").children[0].children[0].textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
assert.equal(pane.querySelector(".entry-list").children[1].children[0].textContent, "—");
assert.equal(secondPane.querySelector(".entry-list").children[0].children.length, 0);
const timeShortcut = { target: input, key: "t", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(timeShortcut);
assert(timeShortcut.prevented);
assert.equal(pane.querySelector(".toggle-times").attributes["aria-pressed"], "false");
assert(!pane.querySelector(".entry-list").classList.contains("show-modified"));
assert.equal(pane.querySelector(".entry-list").children[0].children.length, 0);
assert.strictEqual(document.activeElement, input);
assert.equal(input.value, "~/editing");
const focusedEntry = pane.querySelector(".entry-list").children[0];
focusedEntry.focus();
const focusedTimeShortcut = { target: focusedEntry, key: "t", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(focusedTimeShortcut);
assert.strictEqual(document.activeElement, focusedEntry);
assert.strictEqual(pane.querySelector(".entry-list").children[0], focusedEntry);
input.focus();
for (const handler of document.events.keydown) handler(timeShortcut);
secondPane.querySelector(".toggle-times").fire("click");
window.dirGroup.receiveDirectory({ paneId: "2", path: "/home/other", entries: [
  { name: ".second", directory: true, modified: 1700000000 }, { name: ".config", directory: false }
] });
assert.equal(secondPane.querySelector(".toggle-times").attributes["aria-pressed"], "true");
assert.equal(secondPane.querySelector(".entry-list").children[0].children.length, 1);
pane.querySelector(".entry-list").children[1].fire("click", { ctrlKey: true });
ids["#show-hidden-entries"].checked = false;
ids["#show-hidden-entries"].fire("change");
assert.equal(settingsCalls.at(-1).showHiddenEntries, false);
assert.equal(pane.querySelector(".entry-list").children.length, 1);
assert.equal(pane.querySelector(".entry-list").children[0].querySelector(".entry-name").textContent, "visible");
assert.equal(secondPane.querySelector(".entry-list").children.length, 0);
pane.focus();
const deletion = { target: pane, key: "Delete", preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(deletion);
assert(deletion.prevented);
assert.equal(operationCalls.length, 0); // Hidden selected files and folders must not remain selected.
ids["#show-hidden-entries"].checked = true;
ids["#show-hidden-entries"].fire("change");
assert.equal(pane.querySelector(".entry-list").children.length, 3);
assert.equal(secondPane.querySelector(".entry-list").children.length, 2);
input.focus();
const switchPane = { target: input, key: "Tab", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(switchPane);
assert(switchPane.prevented);
assert.equal(document.activeElement.dataset.paneId, "2");
const targetedPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "1")[0];
window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [
  { name: "a", directory: false }, { name: "b", directory: false }, { name: "c", directory: false },
  { name: "d", directory: false }, { name: "e", directory: false }, { name: "f", directory: false }
] });
const gridEntries = targetedPane.querySelector(".entry-list").children;
[[0, 0], [250, 0], [0, 30], [250, 30], [0, 60], [500, 0]].forEach(([left, top], index) => {
  gridEntries[index].getBoundingClientRect = () => ({ left, right: left + 200, top, bottom: top + 20 });
});
const selectedGridEntry = () => [...gridEntries].find(entry => entry.classList.contains("selected"));
targetedPane.fire("pointerdown");
gridEntries[2].fire("click");
const gridKey = key => {
  const event = { target: targetedPane, key, preventDefault() { this.prevented = true; } };
  for (const handler of document.events.keydown) handler(event);
  assert(event.prevented);
};
gridKey("ArrowRight");
assert.strictEqual(selectedGridEntry(), gridEntries[3]);
gridKey("ArrowDown");
assert.strictEqual(selectedGridEntry(), gridEntries[3]); // The next row in this column does not exist.
gridKey("ArrowLeft");
assert.strictEqual(selectedGridEntry(), gridEntries[2]);
gridEntries[4].fire("click");
gridKey("ArrowRight");
assert.strictEqual(selectedGridEntry(), gridEntries[4]); // The adjacent column has no matching row.
const gridList = targetedPane.querySelector(".entry-list");
gridList.clientWidth = 500;
targetedPane.querySelector(".toggle-times").fire("click");
assert.equal(gridList.style.getPropertyValue("--entry-columns"), "1");
targetedPane.querySelector(".toggle-times").fire("click");
assert.equal(gridList.style.getPropertyValue("--entry-columns"), "2");
window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [
  { name: "Docs", directory: true }, { name: "Downloads", directory: true },
  { name: "docs.txt", directory: false }, { name: "日本語.txt", directory: false }
] });
const searchBox = targetedPane.children.find(child => child.className === "incremental-search");
const searchInput = searchBox.children[0];
assert.equal(searchInput.attributes.placeholder, undefined);
const searchEntries = targetedPane.querySelector(".entry-list").children;
const searchKey = (target, key, props = {}) => {
  const event = { target, key, ...props, preventDefault() { this.prevented = true; } };
  for (const handler of document.events.keydown) handler(event);
  return event;
};
targetedPane.fire("pointerdown");
assert(searchKey(targetedPane, "d").prevented);
assert(!searchBox.hidden);
assert.equal(searchInput.value, "d");
assert(searchEntries[0].classList.contains("selected"));
searchInput.value = "DOC";
searchInput.fire("input");
assert(searchEntries[0].classList.contains("selected"));
searchKey(searchInput, "ArrowDown");
assert(searchEntries[2].classList.contains("selected"));
searchKey(searchInput, "ArrowDown");
assert(searchEntries[0].classList.contains("selected"));
searchKey(searchInput, "ArrowUp");
assert(searchEntries[2].classList.contains("selected"));
searchInput.value = "missing";
searchInput.fire("input");
assert(searchEntries[2].classList.contains("selected"));
const opensBeforeNoMatch = openCalls.length;
searchKey(searchInput, "Enter");
assert.equal(openCalls.length, opensBeforeNoMatch);
assert(searchBox.hidden);
searchKey(targetedPane, "f", { ctrlKey: true });
assert(!searchBox.hidden);
searchInput.value = "日本語";
searchInput.fire("input", { isComposing: true });
assert(searchEntries[2].classList.contains("selected"));
searchInput.fire("compositionend");
assert(searchEntries[3].classList.contains("selected"));
searchKey(searchInput, "Escape");
assert(searchBox.hidden);
assert(searchEntries[3].classList.contains("selected"));
searchKey(targetedPane, "d");
searchInput.value = "docs.txt";
searchInput.fire("input");
searchKey(searchInput, "Enter");
assert.equal(openCalls.at(-1).path, "/home/test/docs.txt");
assert(searchBox.hidden);
targetedPane.querySelector(".split-horizontal").fire("click");
assert.equal(directoryCalls.at(-1).path, "/home/test");
assert.equal(document.activeElement.dataset.paneId, "4");
const newPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "4")[0];
let displayed = find(workspace, node => node.className === "pane");
assert.deepEqual(displayed.map(node => node.dataset.paneId), ["1", "4", "2", "3"]);
assert.deepEqual(displayed.map(node => node.querySelector(".pane-title").textContent), ["1: test", "2: test", "3: other", "4: Documents"]);
window.dirGroup.receiveBookmarks({ action: "add", paths: ["/home/test"] });
ids["#bookmark-menu-button"].fire("click");
ids["#bookmark-popup"].children[0].fire("contextmenu", { clientX: 0, clientY: 0 });
const context = document.body.children.find(node => node.className === "bookmark-context");
const destinations = context.children.find(node => node.className === "bookmark-send").children[1].children;
assert.deepEqual(destinations.map(node => node.textContent), ["Pane 1へ送る", "Pane 2へ送る", "Pane 3へ送る", "Pane 4へ送る"]);
destinations[1].fire("click");
assert.equal(bookmarkCalls.at(-1).paneId, "4");
newPane.querySelector(".close-pane").fire("click");
displayed = find(workspace, node => node.className === "pane");
assert.deepEqual(displayed.map(node => node.querySelector(".pane-title").textContent), ["1: test", "2: other", "3: Documents"]);
for (let i = 0; i < 5; i++) targetedPane.querySelector(".split-horizontal").fire("click");
let paneList = find(workspace, node => node.className === "pane");
assert.equal(paneList.length, 8);
for (let number = 1; number <= 8; number++) {
  const event = { target: targetedPane, key: String(number), altKey: true, preventDefault() { this.prevented = true; } };
  for (const handler of document.events.keydown) handler(event);
  assert(event.prevented);
  assert.strictEqual(document.activeElement, paneList[number - 1]);
}
const customPaneBindings = { ...window.dpaneKeybindings, pane8: "Ctrl+8" };
window.dirGroup.receiveKeybindingsReset({ bindings: customPaneBindings });
const customPaneKey = { target: targetedPane, key: "8", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(customPaneKey);
assert(customPaneKey.prevented);
assert.strictEqual(document.activeElement, paneList[7]);
window.dirGroup.receiveKeybindingsReset({ bindings: window.dpaneKeybindings });

assert(paneList.every(node => node.querySelector(".split-horizontal").disabled && node.querySelector(".split-vertical").disabled));
targetedPane.querySelector(".split-vertical").fire("click");
assert.equal(find(workspace, node => node.className === "pane").length, 8);
for (let id = 9; id >= 5; id--) {
  const added = find(workspace, node => node.className === "pane" && node.dataset.paneId === String(id))[0];
  added.querySelector(".close-pane").fire("click");
}
const pane3 = find(workspace, node => node.className === "pane" && node.dataset.paneId === "3")[0];
pane3.querySelector(".close-pane").fire("click");
assert.deepEqual(find(workspace, node => node.className === "pane").map(node => node.dataset.paneId), ["1", "2"]);
const pane2 = find(workspace, node => node.className === "pane" && node.dataset.paneId === "2")[0];
pane2.querySelector(".close-pane").fire("click");
pane.querySelector(".close-pane").fire("click");
assert.equal(closeCalls.length, 1);
window.dpaneInitialViewSettings = { scale: 120, showHiddenEntries: false, showShortcutHints: false, startupPaneCount: 3 };
window.dpaneStartupTiming = true;
const perfForTiming = { now: () => performance.now(), getEntriesByType(type) {
  if (type === "resource") return [{ name: "file:///local/ui/style.css", startTime: 1, responseEnd: 3, duration: 2 }, { name: "file:///private/name", startTime: 2, responseEnd: 4, duration: 2 }];
  if (type === "navigation") return [{ domContentLoadedEventStart: 5, domContentLoadedEventEnd: 6, loadEventStart: 8, loadEventEnd: 9 }];
  return [];
} };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), { window, document, performance: perfForTiming, setTimeout, clearTimeout, requestAnimationFrame: fn => fn() });
assert.equal(ids["#ui-scale"].value, "120");
assert.equal(ids["#ui-scale-value"].textContent, "120%");
assert.equal(ids["#show-hidden-entries"].checked, false);
assert.equal(ids["#show-shortcut-hints"].checked, false);
document.readyState = "interactive";
document.events.DOMContentLoaded.forEach(handler => handler());
document.readyState = "complete";
window.events.load.forEach(handler => handler());
window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [
  { name: ".hidden", directory: false }, { name: "visible", directory: false }
] });
const restoredPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "1")[0];
assert.equal(restoredPane.querySelector(".entry-list").children.length, 1);
assert.doesNotMatch(restoredPane.querySelector(".status").textContent, /Ctrl\+Tab/);
assert.equal(paintCalls.length, 0);
window.dirGroup.receiveDirectories([
  { paneId: "2", path: "/home/other", entries: [] },
  { paneId: "3", error: "読み込みエラー" }
]);
assert.equal(paintCalls.length, 1);
assert.deepEqual(detailCalls.map(item => item.event), ["js-start", "initial-layout", "dom-content-loaded", "window-load", "list-receive", "list-render", "list-receive", "list-render", "list-receive", "list-render"]);
assert.equal(detailCalls[4].readyState, "complete");
assert.equal(detailCalls[5].paneId, "1");
assert.equal(detailCalls[5].count, 1);
assert.equal(detailCalls[9].count, 0);
window.dirGroup.receiveDirectory({ paneId: "3", path: "/home/other", entries: [] });
assert.equal(paintCalls.length, 1);
assert.equal(detailCalls.length, 10);
flush();
assert.deepEqual(detailCalls.slice(10).map(item => item.event), ["resource-summary", "resource", "resource", "navigation"]);
assert.equal(detailCalls[11].kind, "style.css");
assert.equal(detailCalls[12].kind, "other");
assert(!JSON.stringify(detailCalls).includes("private"));
window.dpaneStartupReply = true;
document.readyState = "loading";
const replies = [];
window.webkit.messageHandlers.initialDirectoryReply = { postMessage(request) {
  const reply = { request };
  replies.push(reply);
  return { then(handler) { reply.resolve = handler; return { catch(reject) { reply.reject = reject; } }; } };
} };
const detailStart = detailCalls.length;
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), { window, document, performance: perfForTiming, setTimeout, clearTimeout, requestAnimationFrame: fn => fn() });
assert.deepEqual(replies.map(reply => reply.request.paneId), ["1", "2", "3"]);
replies[0].resolve({ paneId: "1", path: "/home/test", entries: [{ name: "visible", directory: false }] });
const replyPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "1")[0];
assert.equal(replyPane.querySelector(".entry-list").children.length, 1);
assert(detailCalls.slice(detailStart).some(item => item.event === "list-receive" && item.readyState === "loading"));
const beforeNormalRequest = directoryCalls.length;
replyPane.querySelector(".up").fire("click");
assert.equal(directoryCalls.length, beforeNormalRequest + 1);
replyPane.querySelector(".bookmark-toggle").fire("click");
assert.equal(bookmarkCalls.at(-1).action, "add");
assert.equal(bookmarkCalls.at(-1).path, "/home/test");
window.dirGroup.receiveBookmarks({ action: "add", paths: ["/home/test"] });
assert.equal(replyPane.querySelector(".bookmark-toggle").textContent, "★");
ids["#bookmark-menu-button"].fire("click");
assert.equal(ids["#bookmark-popup"].children[0].children[0].textContent, "📁 test");
ids["#bookmark-popup"].children[0].children[1].fire("click");
assert.equal(bookmarkCalls.at(-1).newPane, true);
const countBeforeError = find(workspace, node => node.className === "pane").length;
window.dirGroup.receiveBookmarks({ error: "読み込みエラー" });
assert.equal(find(workspace, node => node.className === "pane").length, countBeforeError);
window.dirGroup.receiveBookmarks({ action: "open", paneId: "1", newPane: true, path: "/home/test", entries: [] });
assert.equal(find(workspace, node => node.className === "pane").length, countBeforeError + 1);
replyPane.querySelector(".up").fire("click");
const parentRequest = directoryCalls.at(-1);
window.dirGroup.receiveDirectory({ paneId: "1", requestId: parentRequest.requestId, path: "/home", entries: [] });
assert.equal(replyPane.querySelector(".back").disabled, false);
replyPane.querySelector(".back").fire("click");
let backRequest = directoryCalls.at(-1);
assert.equal(backRequest.path, "/home/test");
window.dirGroup.receiveDirectory({ paneId: "1", requestId: backRequest.requestId, error: "アクセスできません" });
assert.equal(replyPane.querySelector(".back").disabled, false);
replyPane.querySelector(".back").fire("click");
backRequest = directoryCalls.at(-1);
window.dirGroup.receiveDirectory({ paneId: "1", requestId: parentRequest.requestId, path: "/stale", entries: [] });
window.dirGroup.receiveDirectory({ paneId: "1", requestId: backRequest.requestId, path: "/home/test", entries: [] });
assert.equal(replyPane.querySelector(".back").disabled, true);
assert.equal(replyPane.querySelector(".path").value, "~");
const replyPane2 = find(workspace, node => node.className === "pane" && node.dataset.paneId === "2")[0];
replies[1].resolve({ paneId: "2", requestId: replies[1].request.requestId, path: "/other", entries: [] });
assert.equal(replyPane2.querySelector(".back").disabled, true);
ids["#reset-keybindings"].fire("click");
assert(resetCalls.length > 0);
const customBindings = { ...window.dpaneKeybindings, showShortcuts: "Ctrl+Shift+H" };
window.dirGroup.receiveKeybindingsReset({ bindings: customBindings });
assert.equal(ids["#shortcut-menu-key"].textContent, "Ctrl+Shift+H");
const customShortcut = { target: replyPane, key: "H", ctrlKey: true, shiftKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(customShortcut);
assert(customShortcut.prevented);
assert.equal(ids["#shortcut-page"].hidden, false);
for (const handler of document.events.keydown) handler(customShortcut);
assert.equal(ids["#shortcut-page"].hidden, true);
window.dirGroup.receiveKeybindingsReset({ bindings: window.dpaneKeybindings });
assert.equal(ids["#shortcut-menu-key"].textContent, "Ctrl+K");
// Maximize preserves the layout; minimizing all panes leaves a usable restore menu.
const currentPanes = () => find(workspace, node => node.className === "pane");
const beforeMaximize = currentPanes().length;
replyPane.querySelector(".maximize-pane").fire("click");
assert.equal(currentPanes().length, 1);
replyPane.querySelector(".maximize-pane").fire("click");
assert.equal(currentPanes().length, beforeMaximize);
replyPane.querySelector(".maximize-pane").fire("click");
const paneSwitch = { target: replyPane, key: "Tab", code: "Tab", ctrlKey: true, preventDefault() {} };
// Only the latest initialization's handler belongs to this workspace state.
const normalOrder = ["1", "4", "2", "3"];
document.events.keydown.at(-2)(paneSwitch);
assert.equal(currentPanes().length, 1);
assert.equal(currentPanes()[0].dataset.paneId, normalOrder[1]);
assert.strictEqual(document.activeElement, currentPanes()[0]);
const previousSwitch = { ...paneSwitch, shiftKey: true };
document.events.keydown.at(-2)(previousSwitch);
assert.equal(currentPanes()[0].dataset.paneId, normalOrder[0]);
document.events.keydown.at(-2)(previousSwitch);
assert.equal(currentPanes()[0].dataset.paneId, normalOrder.at(-1));
document.events.keydown.at(-2)(paneSwitch);
assert.equal(currentPanes()[0].dataset.paneId, normalOrder[0]);
currentPanes()[0].querySelector(".maximize-pane").fire("click");
assert.equal(currentPanes().length, beforeMaximize);
while (currentPanes().length) currentPanes()[0].querySelector(".minimize-pane").fire("click");
assert.equal(ids["#pane-bar"].children.length, beforeMaximize);
assert(ids["#pane-bar"].children.every(button => !/^\d+: /.test(button.textContent)));
const closesBefore = closeCalls.length;
ids["#pane-bar"].children[0].fire("click");
assert.equal(currentPanes().length, 1);
currentPanes()[0].querySelector(".close-pane").fire("click");
assert.equal(closeCalls.length, closesBefore);
assert.equal(currentPanes().length, 0);
window.dirGroup.receiveBookmarks({ action: "add", paths: ["/home/test"] });
ids["#bookmark-popup"].children[0].children[0].fire("click");
assert.equal(bookmarkCalls.at(-1).newPane, true);
window.dirGroup.receiveBookmarks({ action: "open", newPane: true, path: "/home/test", entries: [] });
assert.equal(currentPanes().length, 1);
ids["#pane-bar"].children[0].fire("click");
assert.equal(currentPanes().length, 2);
assert.equal(workspace.children[0].className, "split horizontal");
// The limit includes minimized panes, including when no pane is visible.
for (let i = 0; i < 4; i++) currentPanes()[0].querySelector(".split-horizontal").fire("click");
assert.equal(currentPanes()[0].querySelector(".split-horizontal").disabled, true);
while (currentPanes().length) currentPanes()[0].querySelector(".minimize-pane").fire("click");
window.dirGroup.receiveBookmarks({ action: "add", paths: ["/home/test"] });
const callsAtLimit = bookmarkCalls.length;
ids["#bookmark-popup"].children[0].children[0].fire("click");
assert.equal(bookmarkCalls.length, callsAtLimit);
assert(alerts.at(-1).includes("最大8個"));
ids["#pane-bar"].children[0].fire("click");
assert.equal(currentPanes().length, 1);
// Folder buttons preserve creation order and distinguish maximized and minimized panes.
const bar = ids["#pane-bar"];
assert.equal(bar.children[0].className, "pane-bar-visible");
assert.equal(bar.children[1].className, "pane-bar-minimized");
assert(/^1: /.test(bar.children[0].textContent));
assert(!/^\d+: /.test(bar.children[1].textContent));
bar.children[0].fire("click");
assert.equal(bar.children[0].className, "pane-bar-maximized");
document.events.keydown.at(-2)({ ...paneSwitch, target: currentPanes()[0] });
assert.equal(bar.children[0].className, "pane-bar-maximized");
assert.equal(currentPanes().length, 1);
bar.children[1].fire("click");
assert.equal(currentPanes().length, 2);
assert.equal(bar.children[0].className, "pane-bar-visible");
assert.equal(bar.children[1].className, "pane-bar-visible");
const secondDisplayed = currentPanes()[1];
bar.children[0].fire("click");
document.events.keydown.at(-2)({ ...paneSwitch, target: currentPanes()[0] });
assert.strictEqual(currentPanes()[0], secondDisplayed);
assert.equal(bar.children[1].className, "pane-bar-maximized");
document.events.keydown.at(-2)({ ...previousSwitch, target: currentPanes()[0] });
assert.equal(bar.children[0].className, "pane-bar-maximized");
document.events.keydown.at(-2)({ target: currentPanes()[0], key: "2", altKey: true, preventDefault() {} });
assert.equal(currentPanes().length, 2);
assert.strictEqual(document.activeElement, secondDisplayed);
bar.children[0].fire("click");
bar.children[1].fire("click");
assert.equal(currentPanes().length, 1);
assert.strictEqual(currentPanes()[0], secondDisplayed);
assert.equal(bar.children[1].className, "pane-bar-maximized");
bar.children[1].fire("click");
assert.equal(currentPanes().length, 2);
const stableButtons = [...bar.children];
const updatedPaneId = currentPanes()[0].dataset.paneId;
window.dirGroup.receiveDirectory({ paneId: updatedPaneId, path: "/new/folder", entries: [] });
assert.strictEqual(bar.children[0], stableButtons[0]);
assert.equal(bar.children[0].textContent, "1: folder");
assert.equal(currentPanes()[0].querySelector(".pane-title").textContent, "1: folder");
assert.equal(bar.children[0].title, "/new/folder");
const secondPaneId = currentPanes()[1].dataset.paneId;
window.dirGroup.receiveDirectory({ paneId: secondPaneId, path: "/new/folder", entries: [] });
assert.equal(bar.children[1].textContent, "2: folder");
assert.equal(currentPanes()[1].querySelector(".pane-title").textContent, "2: folder");
assert.equal(bar.children[0].title, bar.children[1].title);
bar.children[1].fire("click");
assert.equal(currentPanes().length, 1);
assert.equal(currentPanes()[0].dataset.paneId, secondPaneId);
console.log("Path completion UI checks passed.");
