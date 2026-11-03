// Stretchtext Anywhere - background service worker.
// Owns the Pollinations device-flow sign-in and the per-site enabled state.

const ENTER = "https://enter.pollinations.ai";
const CLIENT_ID = "pk_POWozQF1U02aw3Ow"; // publishable app key (attribution + consent screen)

async function getStored(keys) {
    return chrome.storage.local.get(keys);
}

async function deviceStart() {
    const res = await fetch(`${ENTER}/api/device/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
    return res.json();
}

async function devicePoll(deviceCode, interval, expiresIn) {
    const deadline = Date.now() + expiresIn * 1000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        const res = await fetch(`${ENTER}/api/device/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: deviceCode, client_id: CLIENT_ID }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.access_token) return body.access_token;
        if (body.error === "authorization_pending") continue;
        if (body.error === "slow_down") { interval += 2; continue; }
        throw new Error(body.error_description || body.error || `token poll failed: ${res.status}`);
    }
    throw new Error("sign-in timed out");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        switch (msg.type) {
            case "signin:start": {
                const data = await deviceStart();
                devicePoll(data.device_code, data.interval ?? 5, data.expires_in ?? 1800)
                    .then((token) => chrome.storage.local.set({ token, signedInAt: Date.now() }))
                    .catch(() => chrome.storage.local.remove("pendingSignin"));
                await chrome.storage.local.set({ pendingSignin: true });
                return { verification_url: data.verification_uri_complete || data.verification_uri, user_code: data.user_code };
            }
            case "signin:status": {
                const s = await getStored(["token", "pendingSignin"]);
                return { signedIn: !!s.token, pending: !!s.pendingSignin && !s.token };
            }
            case "signout":
                await chrome.storage.local.remove(["token", "pendingSignin"]);
                return { ok: true };
            case "site:get": {
                const { enabledSites = {} } = await getStored("enabledSites");
                return { enabled: !!enabledSites[msg.host] };
            }
            case "site:set": {
                const { enabledSites = {} } = await getStored("enabledSites");
                enabledSites[msg.host] = !!msg.enabled;
                await chrome.storage.local.set({ enabledSites });
                const id = "stx-" + msg.host;
                if (msg.enabled) {
                    await chrome.scripting.registerContentScripts([{
                        id,
                        matches: [`*://${msg.host}/*`],
                        js: ["content.js"],
                        css: ["content.css"],
                        runAt: "document_idle",
                    }]).catch(() => {});
                    if (msg.tabId) {
                        await chrome.scripting.insertCSS({ target: { tabId: msg.tabId }, files: ["content.css"] }).catch(() => {});
                        await chrome.scripting.executeScript({ target: { tabId: msg.tabId }, files: ["content.js"] }).catch(() => {});
                    }
                } else {
                    await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
                    await chrome.permissions.remove({ origins: [`*://${msg.host}/*`] }).catch(() => {});
                }
                return { ok: true };
            }
            case "settings:get": {
                const s = await getStored(["model", "maxDepth"]);
                return { model: s.model || "openai/gpt-5.4-nano", maxDepth: s.maxDepth ?? 3 };
            }
            case "settings:set":
                await chrome.storage.local.set(msg.settings);
                return { ok: true };
            case "expand": {
                const { token } = await getStored("token");
                if (!token) return { error: "not_signed_in" };
                const res = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: msg.model,
                        messages: [
                            { role: "system", content: "You extend hypertext in the style of Ted Nelson's stretchtext. Given a sentence and its surrounding paragraph, write one or two sentences of elaboration that read as a natural continuation of the original author's voice. Plain prose, no headings, no meta commentary." },
                            { role: "user", content: `Paragraph:\n${msg.paragraph}\n\nSentence to expand:\n${msg.sentence}` },
                        ],
                        max_completion_tokens: 160,
                    }),
                });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) return { error: body?.error?.message || `gen request failed: ${res.status}` };
                const text = body?.choices?.[0]?.message?.content?.trim();
                if (!text) return { error: "empty response" };
                return { text };
            }
            default:
                return { error: "unknown message" };
        }
    })().then(sendResponse, (err) => sendResponse({ error: String(err.message || err) }));
    return true; // async response
});
