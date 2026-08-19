// inpage/wa-injector.js: waits for the WPP (wa-js) runtime to become usable
// after the vendor bundle has been injected into the page.
(function () {
  const bus = (type, payload) => window.postMessage({ __from: 'wamd:inpage', type, payload }, '*');
  const log = (m) => bus('wa:log', m);

  async function waitReady() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        // Check the specific APIs we actually need rather than
        // WPP.webpack.isReady(), which can stay false indefinitely on some
        // WhatsApp Web builds even once chat APIs are fully usable.
        if (
          window.WPP?.chat &&
          typeof window.WPP.chat.list === 'function' &&
          typeof window.WPP.chat.getMessages === 'function'
        ) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  (async () => {
    try {
      // content.js injects the vendor bundle before this script; this is a
      // belt-and-braces fallback in case it needs loading here instead.
      if (!window.WPP && window.__WAMD_WAJS_BLOB_URL) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = window.__WAMD_WAJS_BLOB_URL;
          s.async = false;
          s.onload = () => { resolve(); s.remove(); };
          s.onerror = (e) => { reject(e); s.remove(); };
          (document.head || document.documentElement).appendChild(s);
        });
      }

      const ok = await waitReady();
      log(ok ? 'WA-JS ready' : 'WA-JS did not become ready in time');
    } catch (e) {
      log('Injector error: ' + e.message);
    }
  })();
})();
