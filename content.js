// content.js: thin bridge between the WhatsApp Web page (MAIN world script,
// inpage/app.js) and the extension (popup.js / background.js).
(function () {
  // The manifest registers this script and popup.js also injects it when a
  // ping goes unanswered, so the same isolated world can receive it more than
  // once. Without this guard each injection adds another pair of listeners,
  // and every popup command then reaches the page once per listener, running
  // whole downloads two or three times over concurrently.
  if (window.__WAMD_CONTENT_LOADED__) return;
  window.__WAMD_CONTENT_LOADED__ = true;

  // Page -> extension (background or popup).
  window.addEventListener('message', (ev) => {
    const { data } = ev;
    if (!data || data.__from !== 'wamd:inpage') return;

    // Downloads need an ACK routed back to the page so app.js knows whether
    // chrome.downloads.download() succeeded.
    if (data.type === 'wa:download') {
      try {
        chrome.runtime.sendMessage(
          { type: 'wa:download', payload: data.payload },
          (res) => {
            try {
              window.postMessage({
                __from: 'wamd:content',
                type: 'wa:download:ack',
                id: data.id,
                res: res || { ok: false, error: chrome.runtime.lastError?.message || 'no response' }
              }, '*');
            } catch {}
          }
        );
      } catch (e) {
        window.postMessage({
          __from: 'wamd:content',
          type: 'wa:download:ack',
          id: data.id,
          res: { ok: false, error: String(e) }
        }, '*');
      }
      return; // don't also forward this as a generic message
    }

    // Generic forwarding (logs, progress updates, command responses, etc.)
    try {
      chrome.runtime.sendMessage({ __from: 'wamd:content', payload: data });
    } catch {}
  });

  // Popup -> page.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.__to !== 'wamd:content') return;

    // Lightweight ping used by the popup to check whether this content
    // script is alive before sending real commands.
    if (msg.payload && msg.payload.type === 'ping') {
      sendResponse({ ok: true, pong: true });
      return;
    }

    try {
      window.postMessage(msg.payload, '*');
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  });
})();
