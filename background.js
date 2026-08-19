// background.js: MV3 service worker.
//
// Service workers have no persistent DOM, so URL.createObjectURL() for a Blob
// is not reliably available here. Instead we accept a base64 payload from the
// page and hand Chrome a data: URL, which chrome.downloads.download() can
// always save regardless of context.
//
// Routing every save through this single API call (instead of clicking an
// <a download> inside the WhatsApp Web page) is what lets the extension save
// many files back-to-back without Chrome's "this site is trying to download
// multiple files" prompt, which only fires for page-initiated downloads.

const downloads = chrome.downloads;

// Chrome runs this as a service worker, where URL.createObjectURL does not
// exist, so saves there go out as a data: URL. Firefox runs it as an event
// page, which has that API, and refuses data: URLs in downloads.download()
// outright. Pick whichever the engine actually supports.
function buildDownloadUrl(b64, mime) {
  const type = mime || 'application/octet-stream';

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  return { url: `data:${type};base64,${b64}`, revoke: () => {} };
}

// Fallback: raw ArrayBuffer -> base64 (used only if a caller ever sends a
// buffer instead of a pre-encoded string).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'wa:download') {
        const { base64, arrayBuffer, filename, mime } = msg.payload || {};
        if (!filename) {
          sendResponse({ ok: false, error: 'missing filename' });
          return;
        }

        const b64 = base64 || (arrayBuffer ? arrayBufferToBase64(arrayBuffer) : null);
        if (!b64) {
          sendResponse({ ok: false, error: 'missing file data (base64/arrayBuffer)' });
          return;
        }

        const { url, revoke } = buildDownloadUrl(b64, mime);

        try {
          await downloads.download({
            url,
            filename,
            saveAs: false,
            conflictAction: 'uniquify'
          });
        } finally {
          // Revoking straight away would cancel a download still being
          // written, so hold the URL open well past the handoff.
          setTimeout(revoke, 60000);
        }

        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'wa:log') {
        console.log('[WA Media Downloader]', msg.message);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: 'unknown message type' });
    } catch (e) {
      console.error('[WA Media Downloader] background error:', e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep the message channel open for the async response
});
