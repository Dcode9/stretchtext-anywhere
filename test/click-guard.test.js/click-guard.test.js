// Regression tests for the maintainer-reported request-control defects:
//  1. page-synthesized clicks (isTrusted=false) must never trigger a paid request
//  2. a second click while an expansion request is in flight must not start another
// Runs content.js in a vm with minimal DOM/chrome stubs; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "content.js");

function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        contains: (c) => set.has(c),
        toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    };
}

function makeEl() {
    return { className: "", dataset: {}, children: [], appendChild(c) { this.children.push(c); }, textContent: "" };
}

function makeSentenceSpan() {
    return {
        classList: makeClassList(["stx-sentence"]),
        dataset: { depth: "0" },
        textContent: "A sentence long enough to expand.",
        closest: () => ({ textContent: "The paragraph around the sentence." }),
        nextElementSibling: null,
        after(el) { this.inserted = el; },
    };
}

async function harness() {
    const expandCalls = [];
    let clickHandler = null;
    const deferreds = [];
    const send = (msg) => {
        if (msg.type === "site:get") return Promise.resolve({ enabled: true });
        if (msg.type === "settings:get") return Promise.resolve({});
        if (msg.type === "expand") {
            expandCalls.push(msg);
            return new Promise((resolve) => deferreds.push(resolve));
        }
        return Promise.resolve({});
    };
    const noopEl = makeEl();
    const documentStub = {
        addEventListener: (type, fn) => { if (type === "click") clickHandler = fn; },
        documentElement: { classList: makeClassList() },
        querySelectorAll: () => [],
        createElement: () => makeEl(),
        createTextNode: (t) => ({ text: t }),
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    const context = vm.createContext({
        window: {},
        location: { host: "example.com" },
        chrome: { runtime: { sendMessage: send, onMessage: { addListener: () => {} } } },
        document: documentStub,
        MutationObserver: class { observe() {} disconnect() {} },
        NodeFilter: { SHOW_TEXT: 4 },
        setTimeout, clearTimeout, console,
    });
    vm.runInContext(readFileSync(SRC, "utf8"), context);
    await new Promise((r) => setImmediate(r)); // let init() finish enabling
    const click = (span, isTrusted) =>
        clickHandler({ isTrusted, target: { closest: (s) => (s === ".stx-sentence" ? span : null) }, preventDefault() {}, stopPropagation() {} });
    return { expandCalls, deferreds, click };
}

test("page-synthesized click (isTrusted=false) triggers no request", async () => {
    const { expandCalls, click } = await harness();
    click(makeSentenceSpan(), false);
    await new Promise((r) => setImmediate(r));
    assert.equal(expandCalls.length, 0);
});

test("second click while a request is in flight starts no second request", async () => {
    const { expandCalls, deferreds, click } = await harness();
    const span = makeSentenceSpan();
    click(span, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(expandCalls.length, 1);
    assert.equal(span.classList.contains("stx-loading"), true);
    click(span, true); // same sentence, request still pending
    click(span, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(expandCalls.length, 1);
    // let the request finish; a click on the grown sentence collapses, no new request
    deferreds[0]({ text: "An elaboration in the author's voice." });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    click(span, true);
    await new Promise((r) => setImmediate(r));
    assert.equal(expandCalls.length, 1);
});

test("direct re-entry into expand while loading is also blocked", async () => {
    const { expandCalls, deferreds, click } = await harness();
    const span = makeSentenceSpan();
    click(span, true);
    await new Promise((r) => setImmediate(r));
    deferreds[0]({ text: "Done." });
    await new Promise((r) => setImmediate(r));
    assert.equal(expandCalls.length, 1);
    assert.equal(span.classList.contains("stx-loading"), false);
});
