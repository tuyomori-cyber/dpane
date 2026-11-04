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
    for (const name of ["path", "status", "entry-list", "up", "close-pane", "split-horizontal", "split-vertical", "entry-name", "toggle-times"]) {
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
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, bottom: 20, width: 200 }; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  closest(selector) { let node = this; while (node) { if (selector === "#workspace" && node === workspace) return node; node = node.parent; } return null; }
  fire(name, props = {}) {
    const event = { target: this, key: "", preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...props };
    for (const fn of this.events[name] || []) { fn(event); if (event.stopped) break; }
    return event;
  }
}

const workspace = new Element("main");
const ids = { "#workspace": workspace, "#ui-scale": new Element(), "#ui-scale-value": new Element(), "#show-hidden-folders": new Element(), ".view-menu": new Element() };
ids["#show-hidden-folders"].checked = true;
const document = { body: new Element("body"), activeElement: null, events: {}, querySelector: id => ids[id], createElement: tag => new Element(tag), addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
const calls = [], directoryCalls = [], closeCalls = [], scaleCalls = [], operationCalls = [];
const window = { innerWidth: 1200, innerHeight: 800, webkit: { messageHandlers: { directoryListing: { postMessage: value => directoryCalls.push(value) }, pathCompletion: { postMessage: value => calls.push(value) }, closeWindow: { postMessage: value => closeCalls.push(value) }, uiScale: { postMessage: value => scaleCalls.push(value) }, fileOperation: { postMessage: value => operationCalls.push(value) } } } };
const timers = new Map(); let nextTimer = 0;
const setTimeout = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
const clearTimeout = id => timers.delete(id);
const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), { window, document, setTimeout, clearTimeout, requestAnimationFrame: fn => fn() });
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

window.dirGroup.receiveDirectory({ paneId: "1", path: "/home/test", entries: [
  { name: ".hidden", directory: true, modified: 1700000000 }, { name: ".file", directory: false, modified: null }, { name: "visible", directory: true, modified: 1700000000 }
] });
window.dirGroup.receiveDirectory({ paneId: "2", path: "/home/other", entries: [
  { name: ".second", directory: true }, { name: ".config", directory: false }
] });
const secondPane = find(workspace, node => node.className === "pane" && node.dataset.paneId === "2")[0];
assert.equal(pane.querySelector(".entry-list").children.length, 3);
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
ids["#show-hidden-folders"].checked = false;
ids["#show-hidden-folders"].fire("change");
assert.equal(pane.querySelector(".entry-list").children.length, 2);
assert.equal(secondPane.querySelector(".entry-list").children.length, 1);
pane.focus();
const deletion = { target: pane, key: "Delete", preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(deletion);
assert(deletion.prevented);
assert.equal(operationCalls.length, 0); // Hidden selected folder must not select a different item.
ids["#show-hidden-folders"].checked = true;
ids["#show-hidden-folders"].fire("change");
assert.equal(pane.querySelector(".entry-list").children.length, 3);
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
newPane.querySelector(".close-pane").fire("click");
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
console.log("Path completion UI checks passed.");
