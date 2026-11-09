// Stretchtext Anywhere - content engine.
// Splits paragraphs into clickable sentences; a click grows an inline
// elaboration, a second click shrinks it back. Nested expansions allowed.
// Works on text nodes only, so links and inline formatting survive.

(() => {
    if (window.__stretchtextLoaded) return;
    window.__stretchtextLoaded = true;

    const HOST = location.host;
    const EXPANDABLE = "p, li, blockquote";
    const SKIP_INSIDE = "nav, header, footer, aside, form, code, pre, script, style, [contenteditable]";

    let settings = { model: "openai/gpt-5.4-nano", maxDepth: 3 };
    let enabled = false;
    const cache = new Map(); // key -> expansion text

    const send = (msg) => chrome.runtime.sendMessage(msg);
    const key = (s) => s.length + ":" + s.slice(0, 64);

    // A clickable sentence ends with terminal punctuation (optionally closed
    // by a quote/paren). Fragments and very short matches ("e.g.", "Yes!",
    // "$3."-style splits) stay plain text - they don't need expansion.
    const SENTENCE_RE = /[^.!?]+[.!?]+(?:["')\]]+)?(?=\s|$)/g;
    const MIN_SENTENCE = 15;

    function segmentsOf(text) {
        // [{text, sentence:bool}] preserving separators between sentences.
        const segs = [];
        let last = 0;
        SENTENCE_RE.lastIndex = 0;
        let m;
        while ((m = SENTENCE_RE.exec(text)) !== null) {
            if (m.index > last) segs.push({ text: text.slice(last, m.index), sentence: false });
            segs.push({ text: m[0], sentence: m[0].trim().length >= MIN_SENTENCE });
            last = m.index + m[0].length;
            if (m[0].length === 0) break;
        }
        if (last < text.length) segs.push({ text: text.slice(last), sentence: false });
        return segs;
    }

    function textNodesOf(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) {
            if (n.nodeValue.trim() && !n.parentElement.closest(".stx-expansion")) nodes.push(n);
        }
        return nodes;
    }

    function makeSentenceSpan(sentence, depth) {
        const span = document.createElement("span");
        span.className = "stx-sentence";
        span.textContent = sentence;
        span.dataset.depth = String(depth);
        return span;
    }

    function prepareBlock(el) {
        if (el.dataset.stxReady) return;
        const text = el.textContent.trim();
        if (text.length < 60) return;
        if (el.querySelector("img, video, table, iframe, canvas, svg")) return;
        const count = (text.match(/[^.!?]+[.!?]+(?:["')\]]+)?(?=\s|$)/g) || [])
            .filter((t) => t.trim().length >= MIN_SENTENCE).length;
        if (count < 2) return;
        el.dataset.stxReady = "1";
        for (const node of textNodesOf(el)) {
            const segs = segmentsOf(node.nodeValue);
            if (!segs.some((s) => s.sentence)) continue;
            const frag = document.createDocumentFragment();
            for (const seg of segs) {
                frag.appendChild(seg.sentence
                    ? makeSentenceSpan(seg.text, 0)
                    : document.createTextNode(seg.text));
            }
            node.parentNode.replaceChild(frag, node);
        }
    }

    async function expand(span) {
        if (span.classList.contains("stx-loading")) return; // re-entrancy guard: never two paid requests for one sentence
        const depth = Number(span.dataset.depth || 0);
        if (depth >= settings.maxDepth) return;
        const sentence = span.textContent;
        const paragraph = span.closest(EXPANDABLE)?.textContent || sentence;
        span.classList.add("stx-loading");
        try {
            const cacheKey = key(sentence + "|" + paragraph);
            let text = cache.get(cacheKey);
            if (!text) {
                const res = await send({ type: "expand", sentence, paragraph, model: settings.model });
                if (res?.error) { span.classList.add("stx-error"); return; }
                text = res.text;
                cache.set(cacheKey, text);
            }
            const ext = document.createElement("span");
            ext.className = "stx-expansion";
            ext.dataset.depth = String(depth + 1);
            const pieces = segmentsOf(" " + text.trim());
            for (const seg of pieces) {
                ext.appendChild(seg.sentence
                    ? makeSentenceSpan(seg.text, depth + 1)
                    : document.createTextNode(seg.text));
            }
            span.after(ext);
            span.classList.add("stx-grown");
        } finally {
            span.classList.remove("stx-loading");
        }
    }

    function collapse(span) {
        const next = span.nextElementSibling;
        if (next?.classList.contains("stx-expansion")) next.remove();
        span.classList.remove("stx-grown");
    }

    document.addEventListener("click", (e) => {
        if (!enabled) return;
        // Only real user clicks may spend Pollen: ignore page-synthesized events.
        if (!e.isTrusted) return;
        const span = e.target.closest?.(".stx-sentence");
        if (!span) return;
        // One click, one request: ignore clicks while an expansion is in flight.
        if (span.classList.contains("stx-loading")) return;
        e.preventDefault();
        e.stopPropagation();
        if (span.classList.contains("stx-grown")) collapse(span);
        else expand(span);
    }, true);

    let moTimer = null;
    const observer = new MutationObserver((mutations) => {
        if (!enabled) return;
        clearTimeout(moTimer);
        moTimer = setTimeout(() => {
            for (const mut of mutations) {
                for (const node of mut.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.(EXPANDABLE) && !node.closest(SKIP_INSIDE)) prepareBlock(node);
                    node.querySelectorAll?.(EXPANDABLE).forEach((el) => {
                        if (!el.closest(SKIP_INSIDE)) prepareBlock(el);
                    });
                }
            }
        }, 400);
    });

    function prepareAll() {
        document.querySelectorAll(EXPANDABLE).forEach((el) => {
            if (!el.closest(SKIP_INSIDE)) prepareBlock(el);
        });
    }

    function setEnabled(on) {
        enabled = on;
        document.documentElement.classList.toggle("stx-on", on);
        if (on) {
            prepareAll();
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            observer.disconnect();
            document.querySelectorAll(".stx-expansion").forEach((el) => el.remove());
            document.querySelectorAll(".stx-grown").forEach((el) => el.classList.remove("stx-grown"));
        }
    }

    async function init() {
        const [site, s] = await Promise.all([
            send({ type: "site:get", host: HOST }),
            send({ type: "settings:get" }),
        ]);
        settings = { ...settings, ...s };
        setEnabled(!!site?.enabled);
    }

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "site:changed" && msg.host === HOST) setEnabled(msg.enabled);
        if (msg.type === "settings:changed") init();
    });

    init();
})();
