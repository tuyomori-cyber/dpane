const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.hidden = false;
    this.value = ""; this.selectionStart = this.selectionEnd = 0; this.className = "";
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(value) {
    this.parts = {};
    for (const name of ["path", "status", "entry-list", "up"]) {
      if (value.includes(name)) { this.parts[name] = new Element(); this.parts[name].parent = this; }
    }
  }
  querySelector(selector) { return this.parts?.[selector.slice(1)] || null; }
  querySelectorAll(selector) { return selector === "button" ? this.children : this.children.filter(child => child.className === selector.slice(1)); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  setAttribute() {}
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
const ids = { "#workspace": workspace, "#split-horizontal": new Element(), "#split-vertical": new Element(), "#close-pane": new Element() };
const document = { body: new Element("body"), activeElement: null, events: {}, querySelector: id => ids[id], createElement: tag => new Element(tag), addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
const calls = [], directoryCalls = [];
const window = { innerWidth: 1200, innerHeight: 800, webkit: { messageHandlers: { directoryListing: { postMessage: value => directoryCalls.push(value) }, pathCompletion: { postMessage: value => calls.push(value) } } } };
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
const switchPane = { target: input, key: "Tab", ctrlKey: true, preventDefault() { this.prevented = true; } };
for (const handler of document.events.keydown) handler(switchPane);
assert(switchPane.prevented);
assert.equal(document.activeElement.dataset.paneId, "2");
console.log("Path completion UI checks passed.");
