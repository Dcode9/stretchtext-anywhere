const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let host = "";
let tabId = null;

async function refresh() {
    const { signedIn, pending } = await send({ type: "signin:status" });
    $("signinPanel").style.display = signedIn ? "none" : "block";
    $("mainPanel").style.display = signedIn ? "block" : "none";
    $("signinBtn").style.display = pending ? "none" : "";
    $("deviceStep").style.display = pending ? "block" : "none";
    if (signedIn) {
        const { enabled } = await send({ type: "site:get", host });
        $("toggleSite").textContent = enabled ? "Enabled ✓" : "Enable on this site";
        $("toggleSite").className = enabled ? "" : "primary";
        const s = await send({ type: "settings:get" });
        $("model").value = s.model;
        $("depth").value = String(s.maxDepth);
    }
}

$("signinBtn").addEventListener("click", async () => {
    const res = await send({ type: "signin:start" });
    if (res?.verification_url) {
        $("verifyLink").href = res.verification_url;
        $("userCode").textContent = res.user_code || "";
        chrome.tabs.create({ url: res.verification_url });
        $("signinBtn").style.display = "none";
        $("deviceStep").style.display = "block";
        const timer = setInterval(async () => {
            const st = await send({ type: "signin:status" });
            if (st.signedIn || !st.pending) { clearInterval(timer); refresh(); }
        }, 2000);
    }
});

$("signoutBtn").addEventListener("click", async () => { await send({ type: "signout" }); refresh(); });

$("toggleSite").addEventListener("click", async () => {
    const { enabled } = await send({ type: "site:get", host });
    await send({ type: "site:set", host, enabled: !enabled, tabId });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "site:changed", host, enabled: !enabled }).catch(() => {});
    refresh();
});

$("model").addEventListener("change", async () => {
    await send({ type: "settings:set", settings: { model: $("model").value } });
});
$("depth").addEventListener("change", async () => {
    await send({ type: "settings:set", settings: { maxDepth: Number($("depth").value) } });
});

async function loadModels() {
    try {
        const res = await fetch("https://gen.pollinations.ai/v1/models");
        const body = await res.json();
        const textModels = (body.data || []).filter((m) => m.category === "text");
        $("model").innerHTML = textModels
            .map((m) => `<option value="${m.id}">${m.title || m.id}</option>`)
            .join("");
    } catch {
        $("model").innerHTML = `<option value="openai/gpt-5.4-nano">openai/gpt-5.4-nano</option>`;
    }
}

(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
        try { host = new URL(tab.url).host; tabId = tab.id; } catch {}
    }
    $("siteHost").textContent = host || "this page";
    await loadModels();
    await refresh();
    const s = await send({ type: "settings:get" });
    $("model").value = s.model;
})();
