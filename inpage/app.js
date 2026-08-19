// inpage/app.js: runs in the WhatsApp Web page's MAIN world (via WPP / wa-js).
// Finds media messages in a chat, downloads their blobs, and hands them off
// to the extension (background.js) to save via chrome.downloads.
(function () {
  // Guard against double injection.
  if (window.__WAMD_APP_LOADED__) {
    window.postMessage({ __from: 'wamd:inpage', type: 'wa:log', message: 'app.js already loaded' }, '*');
    return;
  }
  window.__WAMD_APP_LOADED__ = true;

  const busSend = (type, payload) => window.postMessage({ __from: 'wamd:inpage', type, ...payload }, '*');
  const log = (m) => busSend('wa:log', { message: String(m) });

  function withTimeout(promise, ms, label) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  function getTimeoutForMedia(m) {
    const kind = (m.type || m.mediaType || '').toLowerCase();
    if (kind === 'video') return 20000;
    if (kind === 'document') return 12000;
    return 8000; // images/audio
  }

  function getMediaStage(m) {
    const md = m?.mediaData || m?._mediaData;
    return (
      md?.__x_mediaStage ??
      md?.mediaStage ??
      md?.stage ??
      m?.__x_mediaStage ??
      m?.mediaStage ??
      m?.stage ??
      null
    );
  }

  // Cheap pre-check to skip messages we already know can't be downloaded,
  // instead of paying for a doomed download attempt (and its timeout).
  function isProbablyUnavailableByMessage(m) {
    const kind = (m.type || m.mediaType || '').toLowerCase();
    const md = m?.mediaData || m?._mediaData || null;

    const stage = getMediaStage(m);
    const stageUp = stage ? String(stage).toUpperCase() : '';
    if (stageUp && ['REUPLOADING', 'ERROR', 'WAITING', 'PROCESSING'].includes(stageUp)) {
      return true;
    }

    const hasKey = !!(m.mediaKey || md?.mediaKey || md?.key || md?.__x_mediaKey || md?.__x_key);
    const hasPathOrUrl = !!(
      m.directPath || md?.directPath || md?.__x_directPath ||
      m.clientUrl || md?.clientUrl || md?.url || md?.__x_clientUrl || md?.__x_url ||
      m.deprecatedMms3Url || md?.deprecatedMms3Url || md?.__x_deprecatedMms3Url
    );

    if ((kind === 'image' || kind === 'video' || kind === 'document') && (!hasKey || !hasPathOrUrl)) {
      return true;
    }

    return false;
  }

  function sanitizeFilename(s) {
    return (s || '').replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120);
  }

  const senderNameCache = new Map();

  function widToString(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid;
    return wid._serialized || wid.serialized || wid.user || wid.id || '';
  }

  function cleanSenderFallback(value) {
    const raw = widToString(value);
    if (!raw) return '';
    const user = raw.split('@')[0].split(':')[0];
    return sanitizeFilename(user);
  }

  async function resolveSenderName(message) {
    if (!message) return '';
    if (message.fromMe || message.id?.fromMe) return 'Me';

    const embedded = [
      message.senderObj?.formattedName,
      message.senderObj?.pushname,
      message.senderObj?.name,
      message.authorObj?.formattedName,
      message.authorObj?.pushname,
      message.authorObj?.name,
      message.contact?.formattedName,
      message.contact?.pushname,
      message.contact?.name,
      message.notifyName,
      message.pushname,
      message.senderName
    ].find(v => typeof v === 'string' && v.trim());
    if (embedded) return sanitizeFilename(embedded);

    const senderWid = message.author || message.sender || message.from || message.id?.participant || message.id?.remote;
    const senderId = widToString(senderWid);
    if (!senderId) return '';
    if (senderNameCache.has(senderId)) return senderNameCache.get(senderId);

    let resolved = '';
    try {
      const contactApi = window.WPP?.contact;
      let contact = null;
      if (typeof contactApi?.get === 'function') contact = await contactApi.get(senderId);
      else if (typeof contactApi?.getContact === 'function') contact = await contactApi.getContact(senderId);

      resolved = sanitizeFilename(
        contact?.formattedName || contact?.pushname || contact?.name || contact?.shortName || ''
      );
    } catch (e) {
      log(`resolveSenderName(): contact lookup failed for ${senderId}: ${e?.message || e}`);
    }

    if (!resolved) resolved = cleanSenderFallback(senderId);
    senderNameCache.set(senderId, resolved);
    return resolved;
  }

  function baseNameNoExt(name) {
    if (!name) return '';
    const base = String(name).split(/[\\/]/).pop();
    return base.replace(/\.[a-z0-9]{1,10}$/i, '');
  }

  function extFromFilename(name) {
    if (!name) return '';
    const m = String(name).match(/\.([a-z0-9]{1,10})$/i);
    return m ? m[1].toLowerCase() : '';
  }

  function extFromMime(mime) {
    const m = (mime || '').toLowerCase();
    if (!m) return '';
    if (m.includes('jpeg')) return 'jpg';
    if (m.includes('png')) return 'png';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    if (m.includes('mp4')) return 'mp4';
    if (m.includes('ogg') || m.includes('opus')) return 'ogg';
    if (m.includes('mpeg') && m.includes('audio')) return 'mp3';
    if (m.includes('pdf')) return 'pdf';
    if (m.includes('zip')) return 'zip';
    if (m.includes('rar')) return 'rar';
    if (m.includes('7z')) return '7z';
    if (m.includes('csv')) return 'csv';
    if (m.includes('plain')) return 'txt';
    if (m.includes('json')) return 'json';
    if (m.includes('msword')) return 'doc';
    if (m.includes('vnd.openxmlformats-officedocument.wordprocessingml')) return 'docx';
    if (m.includes('vnd.ms-excel')) return 'xls';
    if (m.includes('vnd.openxmlformats-officedocument.spreadsheetml')) return 'xlsx';
    if (m.includes('vnd.ms-powerpoint')) return 'ppt';
    if (m.includes('vnd.openxmlformats-officedocument.presentationml')) return 'pptx';
    return '';
  }

  /** Best available extension: original filename > mimetype > kind-based fallback. */
  function resolveExt({ message, mime, kind }) {
    const origName = message?.filename || message?.fileName || message?.title || message?.name || '';
    let ext = extFromFilename(origName);
    if (ext) return ext;

    ext = extFromMime(mime);
    if (ext) return ext;

    if ((kind === 'ptt' || kind === 'audio') && (!mime || /opus|ogg/.test(mime || ''))) return 'ogg';
    if (kind === 'document') return 'bin';

    return '';
  }

  function makeFilename({ chatName, senderName, ts, index, mime, caption, extHint, naming, message, kind }) {
    const pad = (n) => String(n).padStart(2, '0');
    let datePart = '';
    if (naming?.useDate) {
      const d = new Date((ts || Math.floor(Date.now() / 1000)) * 1000);
      const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const hms = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      datePart = `_${ymd}_${hms}`;
    }

    let suffix = '';
    if (naming?.captionSuffix && caption) {
      const cap = sanitizeFilename(caption);
      if (cap) suffix += `_${cap}`;
    }

    if (naming?.appendOrigNameAll) {
      const orig = message?.filename || message?.fileName || message?.title || message?.name || '';
      const baseOrig = sanitizeFilename(baseNameNoExt(orig)).slice(0, 80);
      if (baseOrig && !suffix.includes(baseOrig)) suffix += `_${baseOrig}`;
    }

    let senderPart = '';
    if (naming?.includeSenderName && senderName) {
      const safeSender = sanitizeFilename(senderName).slice(0, 60);
      if (safeSender) senderPart = `_${safeSender}`;
    }

    const base = `${sanitizeFilename(chatName || 'Chat')}${senderPart}${datePart}_${String(index).padStart(4, '0')}${suffix}`;
    const ext = extHint || resolveExt({ message, mime, kind });
    return base + (ext ? '.' + ext : '');
  }

  // --- readiness, based on the APIs we actually call ---
  // On some recent wa-js builds WPP.webpack.isReady() can stay false even
  // once WPP.chat is fully usable, which used to add an 8s stall to every
  // command. Poll for the concrete APIs instead.
  let wppReadyConfirmed = false;

  async function ensureReady(timeoutMs = 2500) {
    const hasRequiredApis = () => {
      const W = window.WPP;
      return !!(W && W.chat && typeof W.chat.list === 'function' && typeof W.chat.getMessages === 'function');
    };

    if (wppReadyConfirmed && hasRequiredApis()) return true;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (hasRequiredApis()) {
        wppReadyConfirmed = true;
        return true;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    log('ensureReady(): WPP.chat APIs not available yet, continuing best-effort');
    return false;
  }

  async function listChats() {
    await ensureReady();
    try {
      const list = await window.WPP.chat.list();
      return (list || []).map(c => ({
        id: c?.id?._serialized || c?.id || '',
        name: c?.formattedTitle || c?.contact?.pushname || c?.contact?.name || c?.name || c?.id?.user || 'Chat'
      }));
    } catch (e) {
      log('listChats() ERROR: ' + (e?.message || e));
      return [];
    }
  }

  function msgChatSerialized(m) {
    const r = m?.id?.remote || m?.id?._remote;
    const rs = r?._serialized || (typeof r === 'string' ? r : '');
    return rs || m?.chatId || m?.chat?.id?._serialized || m?.chat?.id || '';
  }

  async function getChatStats(chatId) {
    await ensureReady();
    try {
      let msgs = null;
      try {
        msgs = await window.WPP.chat.getMessages(chatId, { count: 10000 });
      } catch (e1) {
        log('getChatStats(): getMessages(10000) failed, retrying with 3000: ' + (e1?.message || e1));
        try {
          msgs = await window.WPP.chat.getMessages(chatId, { count: 3000 });
        } catch (e2) {
          log('getChatStats(): getMessages(3000) failed, retrying with defaults: ' + (e2?.message || e2));
          msgs = await window.WPP.chat.getMessages(chatId);
        }
      }

      if (msgs && msgs.length) {
        const mismatched = msgs.filter(m => {
          const c = msgChatSerialized(m);
          return c && c !== chatId;
        });

        // If wa-js hasn't initialized this chat yet it can return another
        // chat's messages; open it once and retry.
        if (mismatched.length && mismatched.length > Math.floor(msgs.length * 0.6)) {
          try {
            if (window.WPP?.chat?.openChatBottom) await window.WPP.chat.openChatBottom(chatId);
            else if (window.WPP?.chat?.openChatAt) await window.WPP.chat.openChatAt(chatId);
            await new Promise(r => setTimeout(r, 250));
            msgs = await window.WPP.chat.getMessages(chatId, { count: 5000 });
          } catch (e3) {
            log('getChatStats(): retry after openChat* failed: ' + (e3?.message || e3));
          }
        }

        msgs = msgs.filter(m => {
          const c = msgChatSerialized(m);
          return !c || c === chatId;
        });
      }

      if (!msgs || msgs.length === 0) {
        return { dateRange: 'No messages loaded', totalMedia: 0, images: 0, videos: 0, audio: 0, documents: 0 };
      }

      const mediaMessages = msgs.filter(m => {
        const kind = (m.type || m.mediaType || '').toLowerCase();
        return m.isMedia || m.isMMS || !!m.mediaKey || !!m.mediaData ||
          ['image', 'video', 'ptt', 'audio', 'document', 'sticker'].includes(kind);
      });

      let images = 0, videos = 0, audio = 0, documents = 0;
      mediaMessages.forEach(m => {
        const kind = (m.type || m.mediaType || '').toLowerCase();
        if (kind === 'image') images++;
        else if (kind === 'video') videos++;
        else if (kind === 'ptt' || kind === 'audio') audio++;
        else if (kind === 'document') documents++;
      });

      let oldestDate = null, newestDate = null;
      msgs.forEach(m => {
        const ts = m.t || m.timestamp || 0;
        if (ts > 0) {
          if (!oldestDate || ts < oldestDate) oldestDate = ts;
          if (!newestDate || ts > newestDate) newestDate = ts;
        }
      });

      let dateRange = 'Unknown';
      if (oldestDate && newestDate) {
        const formatDate = (ts) => {
          const d = new Date(ts * 1000);
          return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
        };
        dateRange = `${formatDate(oldestDate)} - ${formatDate(newestDate)}`;
      }

      return { dateRange, totalMedia: mediaMessages.length, images, videos, audio, documents };
    } catch (e) {
      log('getChatStats() ERROR: ' + (e?.message || e));
      return { dateRange: 'Error loading stats', totalMedia: 0, images: 0, videos: 0, audio: 0, documents: 0 };
    }
  }

  // Find the scrollable message-list container. wa-js/getMessages only reads
  // from WhatsApp's local store, so to reach further back in history we still
  // need to nudge WhatsApp's own virtualized list into fetching older
  // messages from the server; there's no public wa-js API for that.
  // Matched structurally rather than by classname, since WhatsApp Web's
  // classnames change between builds.
  function findScrollContainer() {
    const candidates = [
      document.querySelector('[role="application"]'),
      ...document.querySelectorAll('div')
    ].filter(Boolean);

    let best = null;
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    return best;
  }

  function findLoadEarlierButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      const text = (btn.textContent || '').trim();

      // The "load earlier messages" button sits near the top of the pane and
      // has a fairly long, sentence-like label (localized, so we don't match
      // on exact text, just its shape and position).
      if (rect.top >= 0 && rect.top < 400 && text.length > 35 && text.length < 150) {
        const lower = text.toLowerCase();
        const excluded = ['call', 'video', 'menu', 'search', 'emoji', 'attach', 'send'];
        if (!excluded.some(kw => lower.includes(kw))) return btn;
      }
    }
    return null;
  }

  async function loadMoreMessages(chatId) {
    await ensureReady();
    try {
      try {
        await window.WPP.chat.openChatBottom(chatId);
      } catch (e) {
        await window.WPP.chat.openChatAt(chatId);
      }
      await new Promise(r => setTimeout(r, 500));

      const scrollContainer = findScrollContainer();
      if (!scrollContainer) {
        log('loadMoreMessages(): could not find the scrollable message list');
        return { ok: false, error: 'Cannot find scroll container' };
      }

      // Scroll to the top in steps, giving WhatsApp time to load history as
      // it goes rather than jumping straight to scrollTop = 0.
      for (let i = 0; i < 10; i++) {
        scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - 500);
        await new Promise(r => setTimeout(r, 200));
      }
      scrollContainer.scrollTop = 0;

      // Keep it pinned to the top briefly while WhatsApp settles content in.
      let scrollLocked = true;
      const lockScroll = () => { if (scrollLocked) scrollContainer.scrollTop = 0; };
      scrollContainer.addEventListener('scroll', lockScroll);
      await new Promise(r => setTimeout(r, 1500));
      scrollContainer.scrollTop = 0;
      await new Promise(r => setTimeout(r, 500));

      const loadMoreBtn = findLoadEarlierButton();
      scrollLocked = false;
      scrollContainer.removeEventListener('scroll', lockScroll);

      if (!loadMoreBtn) {
        return { ok: true, clicked: false, message: 'No load-more button found (all history may already be loaded)' };
      }

      if (!document.contains(loadMoreBtn)) {
        return { ok: false, error: 'Button disappeared before it could be clicked' };
      }

      try {
        loadMoreBtn.click();
      } catch (e) {
        loadMoreBtn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
      }

      await new Promise(r => setTimeout(r, 3000));
      return { ok: true, clicked: true };
    } catch (e) {
      log('loadMoreMessages() ERROR: ' + (e?.message || e));
      return { ok: false, error: e.message };
    }
  }

  function withinRange(ts, from, to) {
    if (from != null && ts < from) return false;
    if (to != null && ts > to) return false;
    return true;
  }

  function dayRangeToEpochSeconds(dateStr) {
    if (!dateStr) return { start: undefined, end: undefined };
    const [y, m, d] = dateStr.split('-').map(Number);
    const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000);
    const end = Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000);
    return { start, end };
  }

  // Page backwards through chat history collecting media messages that match
  // the requested types/date range.
  async function fetchMediaMessages({ chatId, types, from, to, estimatedBatch = 200, maxBatches = 20 }) {
    const out = [];
    const seenIds = new Set();
    const wanted = new Set(types || []);
    let anchorId = '';
    let batchNo = 0;
    let noNewRepeats = 0;
    let sameAnchorRepeats = 0;
    let didOpenChat = false;

    log(`Scanning "${chatId}" for media (types=[${[...wanted].join(',')}])...`);

    const msgId = (m) => {
      if (typeof m === 'string') return m;
      const v = m?.id?._serialized ?? m?.id;
      return typeof v === 'string' ? v : '';
    };
    const msgTs = (m) => m?.t || m?.timestamp || 0;

    while (batchNo < maxBatches) {
      batchNo++;

      const anchorSerPrev = typeof anchorId === 'string' ? anchorId : (anchorId?._serialized || '');
      const opts = {
        count: estimatedBatch,
        direction: anchorSerPrev ? 'before' : undefined,
        id: anchorSerPrev || undefined
      };

      let batch = [];
      try {
        batch = await window.WPP.chat.getMessages(chatId, opts);
      } catch (e) {
        log(`getMessages() error on batch #${batchNo}: ${e?.message || e}`);
        break;
      }

      const totalRaw = batch?.length || 0;
      if (!totalRaw) break;

      // If wa-js returns another chat's messages (happens when the chat
      // hasn't been initialized client-side yet), filter them out; on the
      // very first batch, open the chat once and restart the scan.
      const mismatched = (batch || []).filter(m => {
        const c = msgChatSerialized(m);
        return c && c !== chatId;
      });

      if (mismatched.length) {
        batch = (batch || []).filter(m => {
          const c = msgChatSerialized(m);
          return !c || c === chatId;
        });

        if (batchNo === 1 && batch.length < Math.max(1, Math.floor(totalRaw * 0.2)) && !didOpenChat) {
          didOpenChat = true;
          try {
            if (window.WPP?.chat?.openChatBottom) await window.WPP.chat.openChatBottom(chatId);
            else if (window.WPP?.chat?.openChatAt) await window.WPP.chat.openChatAt(chatId);
            await new Promise(r => setTimeout(r, 250));

            anchorId = '';
            batchNo = 0;
            out.length = 0;
            seenIds.clear();
            noNewRepeats = 0;
            sameAnchorRepeats = 0;
            log('Chat was not initialized yet, opened it and restarted the scan');
            continue;
          } catch (e) {
            log('openChat* failed while scanning: ' + (e?.message || e));
          }
        }
      }

      if (anchorSerPrev) {
        batch = (batch || []).filter(m => msgId(m) !== anchorSerPrev);
        if (!batch.length) break;
      }

      let newIdsInBatch = 0;
      for (const m of batch) {
        const id = msgId(m);
        if (!id || seenIds.has(id)) continue;
        newIdsInBatch++;

        const ts = msgTs(m);
        const kind = (m.type || m.mediaType || '').toLowerCase();
        const isMedia = m.isMedia || m.isMMS || !!m.mediaKey || !!m.mediaData ||
          ['image', 'video', 'ptt', 'audio', 'document', 'sticker'].includes(kind);

        if (!isMedia) { seenIds.add(id); continue; }
        if (!withinRange(ts, from, to)) { seenIds.add(id); continue; }

        const norm = kind === 'ptt' ? 'audio' : kind;
        if (wanted.size && !wanted.has(norm) && !(wanted.has('ptt') && kind === 'ptt')) {
          seenIds.add(id);
          continue;
        }

        out.push(m);
        seenIds.add(id);
      }

      // Always page by the oldest timestamp seen in this batch, not by
      // array order, wa-js doesn't guarantee ordering, and using the wrong
      // cursor causes large, wasteful overlap between batches.
      let cursorMsg = batch[0];
      let cursorTs = msgTs(cursorMsg);
      for (const x of batch) {
        const t = msgTs(x);
        if (t && (!cursorTs || t < cursorTs)) { cursorMsg = x; cursorTs = t; }
      }
      if (!cursorTs) { cursorMsg = batch[batch.length - 1]; cursorTs = msgTs(cursorMsg); }

      const cursorSer = msgId(cursorMsg);
      if (!cursorSer) break;
      anchorId = cursorSer;

      const maxTs = Math.max(...batch.map(x => msgTs(x) || 0));
      if (from && maxTs < from) break; // everything left is older than requested range

      if (!newIdsInBatch) {
        noNewRepeats++;
        if (noNewRepeats >= 2) break;
      } else {
        noNewRepeats = 0;
      }

      if (anchorSerPrev && anchorSerPrev === anchorId) {
        sameAnchorRepeats++;
        if (sameAnchorRepeats >= 2) break;
      } else {
        sameAnchorRepeats = 0;
      }
    }

    log(`Scan complete, ${out.length} matching media message(s) found`);
    return out;
  }

  function patchWppDownloadMedia() {
    const W = window.WPP?.chat;
    if (!W || W.__wamdDownloadPatched) return;

    function getMediaData(msg) {
      return msg?.mediaData || msg?._mediaData || null;
    }

    // Some WhatsApp Web builds ship a broken forceToBlob() that throws on
    // msgChunks instead of returning null; neutralize it so a single bad
    // cached blob can't take down the whole batch.
    function neutralizeBrokenBlob(msg) {
      const md = getMediaData(msg);
      if (!md) return;

      if (md.mediaBlob && !md.mediaBlob.__wamdSafePatched) {
        const origForce = typeof md.mediaBlob.forceToBlob === 'function'
          ? md.mediaBlob.forceToBlob.bind(md.mediaBlob)
          : null;

        md.mediaBlob.forceToBlob = function () {
          try {
            return origForce ? origForce() : null;
          } catch (e) {
            const emsg = String(e?.message || e || '');
            if (/msgChunks|forceToBlob|Cannot read properties of undefined/i.test(emsg)) return null;
            throw e;
          }
        };
        md.mediaBlob.__wamdSafePatched = true;
      }

      try { if (md.mediaBlob) md.mediaBlob = null; } catch {}
    }

    const origDownloadMediaMessage = typeof W.downloadMediaMessage === 'function'
      ? W.downloadMediaMessage.bind(W) : null;

    if (origDownloadMediaMessage) {
      W.downloadMediaMessage = async function (msg) {
        neutralizeBrokenBlob(msg);
        try {
          return await origDownloadMediaMessage(msg);
        } catch (e) {
          const emsg = String(e?.message || e || '');
          if (/msgChunks|forceToBlob|Cannot read properties of undefined/i.test(emsg)) {
            neutralizeBrokenBlob(msg);
            return await origDownloadMediaMessage(msg);
          }
          throw e;
        }
      };
    }

    const origDownloadMedia = typeof W.downloadMedia === 'function' ? W.downloadMedia.bind(W) : null;
    if (origDownloadMedia) {
      W.downloadMedia = async function (idOrMsg) {
        return await origDownloadMedia(idOrMsg);
      };
    }

    W.__wamdDownloadPatched = true;
  }

  async function getBlobFromMessageCaches(message, idForLog) {
    const md = message?.mediaData || message?._mediaData || null;
    if (!md) return null;

    const mimetype = md.mimetype || message?.mimetype || 'application/octet-stream';
    const filehash = md.filehash || message?.filehash || null;

    try {
      const LruMediaStore = window.LruMediaStore || window.Store?.LruMediaStore || window.WPP?.whatsapp?.LruMediaStore;
      if (filehash && LruMediaStore?.get) {
        const cachedBuffer = await LruMediaStore.get(filehash).catch(() => null);
        if (cachedBuffer) {
          const ab = cachedBuffer instanceof ArrayBuffer ? cachedBuffer
            : cachedBuffer?.buffer instanceof ArrayBuffer ? cachedBuffer.buffer : null;
          if (ab) return new Blob([ab], { type: mimetype });
        }
      }
    } catch {}

    try {
      const MediaBlobCache = window.MediaBlobCache || window.Store?.MediaBlobCache || window.WPP?.whatsapp?.MediaBlobCache;
      if (filehash && MediaBlobCache?.has?.(filehash)) {
        const blob = MediaBlobCache.get(filehash);
        if (blob) return blob;
      }
    } catch {}

    try {
      if (md.mediaBlob && typeof md.mediaBlob.forceToBlob === 'function') {
        try {
          const blob = md.mediaBlob.forceToBlob();
          if (blob) return blob;
        } catch (e) {
          const emsg = String(e?.message || e || '');
          if (/msgChunks|forceToBlob|Cannot read properties of undefined/i.test(emsg)) {
            try { md.mediaBlob = null; } catch {}
            return null;
          }
          throw e;
        }
      }
    } catch {}

    return null;
  }

  let dlFnName = null;

  async function downloadAnyMedia(message) {
    patchWppDownloadMedia();

    const W = window.WPP?.chat || {};
    const id = message?.id?._serialized || message?.id || message?._serialized || message;

    if (message && typeof message === 'object' && typeof message.downloadMedia === 'function') {
      const md = message.mediaData || message._mediaData || null;

      try {
        if (md?.mediaBlob && typeof md.mediaBlob.forceToBlob === 'function' && !md.mediaBlob.__wamdSafePatched) {
          const origForce = md.mediaBlob.forceToBlob.bind(md.mediaBlob);
          md.mediaBlob.forceToBlob = function () {
            try {
              return origForce();
            } catch (e) {
              const emsg = String(e?.message || e || '');
              if (/msgChunks|forceToBlob|Cannot read properties of undefined/i.test(emsg)) return null;
              throw e;
            }
          };
          md.mediaBlob.__wamdSafePatched = true;
        }
      } catch {}

      try { if (md?.mediaBlob) md.mediaBlob = null; } catch {}

      // Force a real fetch rather than reading whatever is cached. WhatsApp
      // Web can hold a low resolution preview blob in memory before the full
      // quality original has been fetched, so taking the cached blob saves
      // images and videos at reduced quality. Calling downloadMedia() again
      // is cheap when the full file is already present.
      await message.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1, isUserInitiated: true });
      await new Promise(r => setTimeout(r, 250));

      let blob = await getBlobFromMessageCaches(message, id);
      if (blob) return blob;

      await new Promise(r => setTimeout(r, 400));
      blob = await getBlobFromMessageCaches(message, id);
      if (blob) return blob;

      throw new Error(`message.downloadMedia() completed but no blob was cached for ${id}`);
    }

    // Fallback: the lower-level WPP.chat API.
    if (!dlFnName) {
      if (typeof W.downloadMediaMessage === 'function') dlFnName = 'downloadMediaMessage(message)';
      else if (typeof W.downloadMedia === 'function') dlFnName = 'downloadMedia(id)';
      else if (typeof W.downloadMessage === 'function') dlFnName = 'downloadMessage(id)';
      else dlFnName = 'NONE';
    }

    if (dlFnName === 'downloadMediaMessage(message)') return await W.downloadMediaMessage(message);
    if (dlFnName === 'downloadMedia(id)') return await W.downloadMedia(id);
    if (dlFnName === 'downloadMessage(id)') return await W.downloadMessage(id);

    throw new Error('No downloadMedia* API available in this WhatsApp Web build');
  }

  async function safeDownloadBlob(m, { timeoutMs = 45000, retries = 1 } = {}) {
    const mid = m?.id?._serialized || m?.id || '';
    const kind = (m.type || m.mediaType || '').toLowerCase();

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const blob = await withTimeout(downloadAnyMedia(m), timeoutMs, `downloadAnyMedia kind=${kind} id=${mid} attempt=${attempt}`);

        if (!blob || typeof blob.arrayBuffer !== 'function') throw new Error('download returned an invalid blob');
        if (typeof blob.size === 'number' && blob.size === 0) throw new Error('blob size = 0 (media not available)');

        return blob;
      } catch (e) {
        if (attempt > retries) {
          log(`SKIP: id=${mid}, kind=${kind} -> ${e?.message || e}`);
        }
        if (attempt <= retries) await new Promise(r => setTimeout(r, 400));
      }
    }

    return null;
  }

  // --- Extension-driven download bridge -----------------------------------
  // Sends the finished file to content.js -> background.js, which saves it
  // via chrome.downloads.download(). Routing saves through the extension
  // (instead of clicking an <a download> here in the page) avoids Chrome's
  // "this site is trying to download multiple files" prompt, which only
  // applies to page-initiated downloads, the real blocker to downloading
  // many files in one go.
  let downloadSeq = 0;
  const pendingDownloads = new Map();

  window.addEventListener('message', (ev) => {
    const { data } = ev;
    if (!data || data.__from !== 'wamd:content' || data.type !== 'wa:download:ack') return;
    const pending = pendingDownloads.get(data.id);
    if (!pending) return;
    pendingDownloads.delete(data.id);
    clearTimeout(pending.timer);
    pending.resolve(data.res);
  });

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function requestDownload({ arrayBuffer, filename, mime }, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve) => {
      const id = `wamd_${Date.now()}_${++downloadSeq}`;
      const base64 = arrayBufferToBase64(arrayBuffer);

      const timer = setTimeout(() => {
        pendingDownloads.delete(id);
        resolve({ ok: false, error: 'download ack timeout' });
      }, timeoutMs);

      pendingDownloads.set(id, { resolve, timer });

      window.postMessage({
        __from: 'wamd:inpage',
        type: 'wa:download',
        id,
        payload: { base64, filename, mime }
      }, '*');
    });
  }

  async function postDownload({ arrayBuffer, filename, mime }) {
    try {
      const res = await requestDownload({ arrayBuffer, filename, mime });
      if (res?.ok) return { ok: true };
      log(`Save failed: ${filename}, ${res?.error || 'unknown error'}`);
      return { ok: false, error: res?.error || 'unknown error' };
    } catch (e) {
      log(`Save failed: ${filename}, ${e?.message || e}`);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // --- Minimal ZIP (STORE, uncompressed) writer ---
  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0 ^ (-1);
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ (-1)) >>> 0;
  }

  function strToUtf8Bytes(str) { return new TextEncoder().encode(str); }
  function u32(n) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, n >>> 0, true); return a; }
  function u16(n) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, n & 0xFFFF, true); return a; }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length || p.byteLength || 0;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
      const u8 = p instanceof Uint8Array ? p : new Uint8Array(p);
      out.set(u8, off);
      off += u8.length;
    }
    return out;
  }

  function writeLocalHeader(nameBytes, crc, size) {
    return concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), nameBytes
    ]);
  }

  function writeCentralHeader(nameBytes, crc, size, offset) {
    return concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBytes
    ]);
  }

  function writeEOCD(count, cdSize, cdOffset) {
    return concat([u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(cdSize), u32(cdOffset), u16(0)]);
  }

  async function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const e of entries) {
      const nameBytes = strToUtf8Bytes(e.name);
      const data = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes);
      const crc = crc32(data);
      const localRec = concat([writeLocalHeader(nameBytes, crc, data.length), data]);
      locals.push(localRec);
      centrals.push(writeCentralHeader(nameBytes, crc, data.length, offset));
      offset += localRec.length;
    }

    const cd = concat(centrals);
    const eocd = writeEOCD(entries.length, cd.length, offset);
    return concat([...locals, cd, eocd]);
  }

  // --- Bounded-concurrency pool ---
  // Runs `worker` over `items` with at most `limit` in flight at once, so a
  // "download everything" batch downloads several files in parallel instead
  // of strictly one at a time, without spawning unbounded concurrent work.
  async function runPool(items, worker, limit) {
    const size = Math.max(1, Math.min(Number(limit) || 4, 8));
    let cursor = 0;
    const results = new Array(items.length);

    async function runNext() {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }

    await Promise.all(Array.from({ length: Math.min(size, items.length) }, runNext));
    return results;
  }

  async function downloadMessages({ chatId, chatsFriendlyMap, types, from, to, naming, pack }) {
    await ensureReady();

    if (!chatId) {
      log('No chat selected');
      return { count: 0 };
    }

    const concurrency = Math.max(1, Math.min(Number(pack?.concurrency) || 4, 8));

    const msgs = await fetchMediaMessages({
      chatId, types, from, to,
      estimatedBatch: pack?.deepScan ? 1000 : 700,
      maxBatches: pack?.deepScan ? 200 : 80
    });

    if (!msgs.length) {
      log('No media found for the selected filters.');
      return { count: 0 };
    }

    log(`Found ${msgs.length} media file(s). Downloading up to ${concurrency} at a time…`);

    const chatName = chatsFriendlyMap.get(chatId) || 'Chat';
    const chatFolder = sanitizeFilename(chatName) || 'Chat';
    const total = msgs.length;
    let processed = 0;
    let saved = 0;

    const reportProgress = () => busSend('wa:progress', { done: processed, total, saved });

    async function prepareEntry(m, i) {
      const index = i + 1;
      const mid = m?.id?._serialized || m?.id || '';
      const kind = (m.type || m.mediaType || '').toLowerCase();
      const ts = m.t || m.timestamp || Math.floor(Date.now() / 1000);

      let result = null;

      if (isProbablyUnavailableByMessage(m)) {
        log(`skip #${index}: ${mid} (${kind}), media not fully available`);
      } else {
        try {
          const blob = await safeDownloadBlob(m, { timeoutMs: getTimeoutForMedia(m), retries: 1 });
          if (!blob) {
            // safeDownloadBlob() already logged the reason.
          } else {
            const arrayBuffer = await blob.arrayBuffer();
            const mime = blob.type || m.mimetype || 'application/octet-stream';
            const senderName = naming?.includeSenderName ? await resolveSenderName(m) : '';
            const filename = makeFilename({
              chatName, senderName, ts, index, mime,
              caption: m.caption || m.body || '', extHint: '', naming, message: m, kind
            });
            result = { filename, mime, arrayBuffer, bytes: new Uint8Array(arrayBuffer) };
          }
        } catch (e) {
          log(`error #${index}: ${mid}, ${e?.message || e}`);
        }
      }

      processed++;
      reportProgress();
      return result;
    }

    if (pack?.saveAsZip) {
      const collected = await runPool(msgs, prepareEntry, concurrency);
      const entries = collected.filter(Boolean).map(e => ({ name: e.filename, bytes: e.bytes }));

      if (!entries.length) {
        log('Nothing to zip. No media could be downloaded.');
        return { count: 0, zip: true };
      }

      log(`Building ZIP with ${entries.length} file(s)…`);
      const zipBytes = await makeZip(entries);
      const zipName = `WA Media Downloads/${chatFolder}_media.zip`;
      const res = await postDownload({ arrayBuffer: zipBytes.buffer, filename: zipName, mime: 'application/zip' });
      saved = res?.ok ? entries.length : 0;
      log(`Done. ${saved}/${total} file(s) zipped.`);
      return { count: saved, zip: true };
    }

    await runPool(msgs, async (m, i) => {
      const entry = await prepareEntry(m, i);
      if (!entry) return;

      const relPath = `WA Media Downloads/${chatFolder}/${entry.filename}`;
      const ack = await postDownload({ arrayBuffer: entry.arrayBuffer, filename: relPath, mime: entry.mime });
      if (ack?.ok) saved++;
      reportProgress();
    }, concurrency);

    log(`Done. ${saved}/${total} file(s) downloaded.`);
    return { count: saved };
  }

  // --- Command handler (popup -> content.js -> here) ---
  window.addEventListener('message', async (ev) => {
    const { data } = ev;
    if (!data || data.__from !== 'wamd:inpage' || data.type !== 'popup:cmd') return;

    const { cmd, payload } = data;

    try {
      if (cmd === 'listChats') {
        const list = await listChats();
        window.postMessage({ __from: 'wamd:inpage', type: 'inpage:resp', cmd, payload: list }, '*');
        return;
      }

      if (cmd === 'getStats') {
        const { selectedChatId } = payload || {};
        if (!selectedChatId) {
          window.postMessage({ __from: 'wamd:inpage', type: 'inpage:error', cmd, error: 'Missing selectedChatId' }, '*');
          return;
        }
        const stats = await getChatStats(selectedChatId);
        window.postMessage({ __from: 'wamd:inpage', type: 'inpage:resp', cmd, payload: stats }, '*');
        return;
      }

      if (cmd === 'loadMore') {
        const { selectedChatId } = payload || {};
        if (!selectedChatId) {
          window.postMessage({ __from: 'wamd:inpage', type: 'inpage:error', cmd, error: 'Missing selectedChatId' }, '*');
          return;
        }
        const result = await loadMoreMessages(selectedChatId);
        window.postMessage({ __from: 'wamd:inpage', type: 'inpage:resp', cmd, payload: result }, '*');
        return;
      }

      if (cmd === 'download') {
        const { chatIds, types, dateFrom, dateTo, naming, pack } = payload || {};
        const ids = Array.isArray(chatIds) ? chatIds.filter(Boolean) : [];

        if (!ids.length) {
          window.postMessage({ __from: 'wamd:inpage', type: 'inpage:error', cmd, error: 'No chat selected' }, '*');
          return;
        }

        const chats = await listChats();
        const map = new Map(chats.map(c => [c.id, c.name]));

        const from = dateFrom ? dayRangeToEpochSeconds(dateFrom).start : undefined;
        const to = dateTo ? dayRangeToEpochSeconds(dateTo).end : undefined;

        let totalCount = 0;
        for (let i = 0; i < ids.length; i++) {
          const chatId = ids[i];
          const chatName = map.get(chatId) || chatId;
          if (ids.length > 1) log(`Chat ${i + 1}/${ids.length}: ${chatName}`);

          const res = await downloadMessages({ chatId, chatsFriendlyMap: map, types, from, to, naming, pack });
          totalCount += res?.count || 0;
        }

        window.postMessage({
          __from: 'wamd:inpage', type: 'inpage:resp', cmd,
          payload: { count: totalCount, chats: ids.length }
        }, '*');
        return;
      }

      window.postMessage({ __from: 'wamd:inpage', type: 'inpage:error', cmd, error: 'Unknown cmd' }, '*');
    } catch (e) {
      window.postMessage({ __from: 'wamd:inpage', type: 'inpage:error', cmd, error: String(e?.message || e) }, '*');
    }
  });

  // Optional direct channel for use from the page's own devtools console,
  // without going through content.js at all.
  window.__WAMD_DIRECT_CMD = async (cmd, payload) => {
    try {
      if (cmd === 'listChats') {
        return { ok: true, data: await listChats() };
      }

      if (cmd === 'download') {
        const { chatIds, selectedChatId, types, dateFrom, dateTo, naming, pack } = payload || {};
        const ids = Array.isArray(chatIds) ? chatIds.filter(Boolean) : (selectedChatId ? [selectedChatId] : []);
        if (!ids.length) return { ok: false, error: 'Missing chatIds' };

        const chats = await listChats();
        const map = new Map(chats.map(c => [c.id, c.name]));
        const from = dateFrom ? dayRangeToEpochSeconds(dateFrom).start : undefined;
        const to = dateTo ? dayRangeToEpochSeconds(dateTo).end : undefined;

        let totalCount = 0;
        for (const chatId of ids) {
          const res = await downloadMessages({ chatId, chatsFriendlyMap: map, types, from, to, naming, pack });
          totalCount += res?.count || 0;
        }
        return { ok: true, data: { count: totalCount, chats: ids.length } };
      }

      return { ok: false, error: 'Unknown cmd' };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  };
})();
