const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.hidden = false;
    this.value = ""; this.selectionStart = this.selectionEnd = 0; this.className = ""; this.attributes = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(value) {
    this.parts = {};
    for (const name of ["path", "status", "entry-list", "up", "back", "close-pane", "split-horizontal", "split-vertical", "entry-name", "toggle-times", "bookmark-toggle", "pane-title"]) {
      if (value.includes(name)) { this.parts[name] = new Element(); this.parts[name].parent = this; }
    }
  }
  querySelector(selector) { return this.parts?.[selector.slice(1)] || this.children.find(child => child.className === selector.slice(1)) || null; }
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
const ids = { "#workspace": workspace, "#ui-scale": new Element(), "#ui-scale-value": new Element(), "#show-hidden-entries": new Element(), "#show-shortcut-hints": new Element(), "#startup-pane-count": new Element(), ".view-menu": new Element(), ".help-menu": new Element(), "#shortcut-page": new Element(), "#open-shortcuts": new Element(), "#close-shortcuts": new Element(), "#bookmark-menu-button": new Element(), "#bookmark-popup": new Element() };
ids["#bookmark-popup"].hidden = true;
ids["#show-hidden-entries"].checked = true;
ids["#show-shortcut-hints"].checked = true;
ids["#ui-scale"].value = "100";
ids["#startup-pane-count"].value = "3";
ids["#shortcut-page"].hidden = true;
const document = { body: new Element("body"), activeElement: null, events: {}, readyState: "loading", pointTarget: null, querySelector: id => ids[id], createElement: tag => new Element(tag), elementFromPoint() { return this.pointTarget; }, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
const calls = [], directoryCalls = [], closeCalls = [], scaleCalls = [], operationCalls = [], settingsCalls = [], paintCalls = [], detailCalls = [];
const bookmarkCalls = [];
const window = { innerWidth: 1200, innerHeight: 800, events: {}, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }, webkit: { messageHandlers: { bookmarks: { postMessage: value => bookmarkCalls.push(value) }, directoryListing: { postMessage: value => directoryCalls.push(value) }, pathCompletion: { postMessage: value => calls.push(value) }, closeWindow: { postMessage: value => closeCalls.push(value) }, uiScale: { postMessage: value => scaleCalls.push(value) }, saveViewSettings: { postMessage: value => settingsCalls.push(value) }, fileOperation: { postMessage: value => operationCalls.push(value) }, startupPaint: { postMessage: value => paintCalls.push(value) }, startupDetail: { postMessage: value => detailCalls.push(value) } } } };
const openCalls = [];
window.webkit.messageHandlers.fileOpen = { postMessage: value => openCalls.push(value) };
const timers = new Map(); let nextTimer = 0;
const setTimeout = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
const clearTimeout = id => timers.delete(id);
const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), { window, document, performance, setTimeout, clearTimeout, requestAnimationFrame: fn => fn() });
const find = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...node.children.flatMap(child => find(child, predicate)) ];
const pane = find(workspace, node => node.className === "pane")[0];
const input = pane.querySelector(".path");
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
assert.match(pane.querySelector(".entry-list").children[0].children[0].textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
assert.equal(pane.querySelector(".entry-list").children[1].children[0].textContent, "—");
assert.equal(secondPane.querySelector(".entry-list").children[0].children.length, 0);
const timeShortcut = { target: input, key: "t", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(timeShortcut);
assert(timeShortcut.prevented);
assert.equal(pane.querySelector(".toggle-times").attributes["aria-pressed"], "false");
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
targetedPane.querySelector(".split-horizontal").fire("click");
assert.equal(directoryCalls.at(-1).path, "/home/test");
assert.equal(document.activeElement.dataset.paneId, "4");
const newPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "4")[0];
let displayed = find(workspace, node => node.className === "pane");
assert.deepEqual(displayed.map(node => node.dataset.paneId), ["1", "4", "2", "3"]);
assert.deepEqual(displayed.map(node => node.querySelector(".pane-title").textContent), ["Pane 1", "Pane 2", "Pane 3", "Pane 4"]);
window.dirGroup.receiveBookmarks({ action: "add", paths: ["/home/test"] });
ids["#bookmark-menu-button"].fire("click");
ids["#bookmark-popup"].children[0].fire("contextmenu", { clientX: 0, clientY: 0 });
const context = document.body.children.find(node => node.className === "bookmark-context");
const destinations = context.children.find(node => node.className === "bookmark-send").children[1].children;
assert.deepEqual(destinations.map(node => node.textContent), displayed.map(node => node.querySelector(".pane-title").textContent));
destinations[1].fire("click");
assert.equal(bookmarkCalls.at(-1).paneId, "4");
newPane.querySelector(".close-pane").fire("click");
displayed = find(workspace, node => node.className === "pane");
assert.deepEqual(displayed.map(node => node.querySelector(".pane-title").textContent), ["Pane 1", "Pane 2", "Pane 3"]);
for (let i = 0; i < 5; i++) targetedPane.querySelector(".split-horizontal").fire("click");
let paneList = find(workspace, node => node.className === "pane");
assert.equal(paneList.length, 8);
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
console.log("Path completion UI checks passed.");
