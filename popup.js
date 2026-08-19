// popup.js: wires the popup UI to the in-page script via content.js.
const D = (sel) => document.querySelector(sel);
const logEl = D('#log');
const progWrap = D('#progressWrap');
const bar = D('#bar');
const chatSel = D('#chatSelect');
const statsSection = D('#statsSection');
const statDateRange = D('#statDateRange');
const statMediaCount = D('#statMediaCount');
const statImages = D('#statImages');
const statVideos = D('#statVideos');
const statAudio = D('#statAudio');
const statDocuments = D('#statDocuments');
const loadMoreBtn = D('#loadMoreBtn');
const closeStatsBtn = D('#closeStatsBtn');

// --- Persist a handful of UI preferences across popup openings ---
const PREFS_KEY = 'wamd_prefs';
const prefSelectors = {
  useDate: '#useDate',
  includeSenderName: '#includeSenderName',
  captionSuffix: '#useCaptionSuffix',
  appendOrigNameAll: '#appendOrigNameAll',
  saveAsZip: '#saveAsZip',
  deepScan: '#deepScan',
  concurrency: '#concurrency'
};

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const [key, selector] of Object.entries(prefSelectors)) {
      const el = D(selector);
      if (!el || !(key in saved)) continue;
      if (el.type === 'checkbox') el.checked = !!saved[key];
      else el.value = saved[key];
    }
  } catch (_) {}
}

function savePrefs() {
  try {
    const values = {};
    for (const [key, selector] of Object.entries(prefSelectors)) {
      const el = D(selector);
      if (!el) continue;
      values[key] = el.type === 'checkbox' ? !!el.checked : el.value;
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(values));
  } catch (_) {}
}

function bindPrefPersistence() {
  loadPrefs();
  for (const selector of Object.values(prefSelectors)) {
    D(selector)?.addEventListener('change', savePrefs);
  }
}

bindPrefPersistence();

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.textContent = (logEl.textContent + '\n' + line).trim();

  // Bound the log buffer so a very large batch (hundreds of files) never
  // turns the <pre> into a multi thousand line DOM node that slows the
  // popup down.
  const lines = logEl.textContent.split('\n');
  const MAX_LINES = 500;
  if (lines.length > MAX_LINES) {
    logEl.textContent = lines.slice(lines.length - MAX_LINES).join('\n');
  }

  logEl.scrollTop = logEl.scrollHeight;
}

function getSelectedChatIds() {
  return Array.from(chatSel.selectedOptions).map(o => o.value).filter(Boolean);
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) throw new Error('No active tab');

  // Prefer an already open, fully loaded WhatsApp Web tab over the active one.
  const waTabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (waTabs && waTabs.length > 0) {
    return waTabs.find(t => t.status === 'complete') || waTabs[0];
  }

  // No WhatsApp Web tab open, load it in the current tab.
  await chrome.tabs.update(activeTab.id, { url: 'https://web.whatsapp.com' });

  // Close the popup while the page loads so the user can reopen it once ready.
  setTimeout(() => {
    try { window.close(); } catch (_) {}
  }, 50);

  throw new Error('Opening WhatsApp Web in this tab. Reopen the extension once it has loaded.');
}

async function runInMain(tabId, func, ...args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
    world: 'MAIN'
  });
  return result;
}

async function injectFile(tabId, file) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [file],
    world: 'MAIN'
  });
}

// Must match APP_VERSION in inpage/app.js.
const APP_VERSION = '1.1.0';

function waitForTabComplete(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return resolve(true);
      } catch (_) {
        return resolve(false);
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 250);
    };
    setTimeout(poll, 300);
  });
}

async function ensureInjected(tabId) {
  // A tab open since before an extension update still has the previous
  // app.js in it, and app.js's own load guard means injecting again is a
  // no-op. The popup would then be sending the current command format to
  // code that predates it, which fails in confusing ways rather than
  // loudly. Reload the tab so the current build gets a clean injection.
  const injected = await runInMain(tabId, () => ({
    loaded: !!window.__WAMD_APP_LOADED__,
    version: window.__WAMD_APP_VERSION__ || null
  }));

  if (injected?.loaded && injected.version !== APP_VERSION) {
    log('Tab is running an older version of the extension. Reloading WhatsApp Web...');
    await chrome.tabs.reload(tabId);
    await waitForTabComplete(tabId);
  }

  const hasWpp = await runInMain(tabId, () => !!window.WPP);
  if (!hasWpp) {
    await injectFile(tabId, 'inpage/vendor/wppconnect-wa-wrapped.js').catch(e => log('Vendor injection error: ' + e.message));
  }

  const appLoaded = await runInMain(tabId, () => !!window.__WAMD_APP_LOADED__);
  if (!appLoaded) {
    log('Loading app...');
    await injectFile(tabId, 'inpage/app.js').catch(e => log('App injection error: ' + e.message));
  }
}

// Ensure content.js is present before tabs.sendMessage, to avoid:
// "Could not establish connection. Receiving end does not exist."
async function ensureContentScript(tabId) {
  const ping = async () => chrome.tabs.sendMessage(tabId, { __to: 'wamd:content', payload: { type: 'ping' } });

  try {
    await ping();
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (_) {}

    await new Promise(r => setTimeout(r, 150));

    try {
      await ping();
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function sendToPage(message) {
  const tab = await getActiveTab();
  await ensureInjected(tab.id);

  const ok = await ensureContentScript(tab.id);
  if (!ok) {
    log('Could not reach the content script. Reload WhatsApp Web and try again.');
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { __to: 'wamd:content', payload: message });
  } catch (err) {
    const ok2 = await ensureContentScript(tab.id);
    if (ok2) {
      await chrome.tabs.sendMessage(tab.id, { __to: 'wamd:content', payload: message });
    } else {
      log('tabs.sendMessage error: ' + (err?.message || String(err)));
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__from !== 'wamd:content') return;
  const data = msg.payload;

  if (data.type === 'wa:log') {
    log(data.message);
  } else if (data.type === 'wa:progress') {
    const { done, total } = data;
    if (total > 0) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      bar.style.width = pct + '%';
    }
  } else if (data.type === 'inpage:resp' && data.cmd === 'listChats') {
    const chats = data.payload || [];
    chatSel.innerHTML = '';

    for (const c of chats) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name + ' (' + c.id + ')';
      chatSel.appendChild(opt);
    }
    chatSel.disabled = false;
    log(`Found ${chats.length} chats. Select one or more, then click Download all.`);
  } else if (data.type === 'inpage:resp' && data.cmd === 'getStats') {
    displayStats(data.payload || {});
  } else if (data.type === 'inpage:error') {
    log('Error: ' + data.error);
  } else if (data.type === 'inpage:resp' && data.cmd === 'download') {
    const { count, chats } = data.payload || { count: 0, chats: 0 };
    log(`Done. Files downloaded: ${count} across ${chats || 1} chat(s).`);
    bar.style.width = '100%';
    setTimeout(() => { progWrap.style.display = 'none'; bar.style.width = '0%'; }, 700);
  }

  sendResponse?.({ ok: true });
});

function getTypes() {
  return Array.from(document.querySelectorAll('.t:checked')).map(x => x.value);
}

D('#filterAll')?.addEventListener('click', () => {
  document.querySelectorAll('.t').forEach(cb => { cb.checked = true; });
});
D('#filterVideosOnly')?.addEventListener('click', () => {
  document.querySelectorAll('.t').forEach(cb => { cb.checked = (cb.value === 'video'); });
});

function displayStats(stats) {
  if (!stats || !stats.dateRange) {
    statsSection.style.display = 'none';
    return;
  }

  statsSection.style.display = 'block';
  statDateRange.textContent = stats.dateRange;
  statMediaCount.textContent = stats.totalMedia || 0;
  statImages.textContent = stats.images || 0;
  statVideos.textContent = stats.videos || 0;
  statAudio.textContent = stats.audio || 0;
  statDocuments.textContent = stats.documents || 0;

  log(`Statistics loaded: ${stats.totalMedia} media files found`);
}

async function loadChatStats() {
  const ids = getSelectedChatIds();
  if (ids.length !== 1) {
    // Detailed stats only make sense for a single chat at a time.
    statsSection.style.display = 'none';
    return;
  }

  log('Loading chat statistics...');
  await sendToPage({
    __from: 'wamd:inpage',
    type: 'popup:cmd',
    cmd: 'getStats',
    payload: { selectedChatId: ids[0] }
  });
}

chatSel.addEventListener('change', loadChatStats);

closeStatsBtn?.addEventListener('click', () => {
  statsSection.style.display = 'none';
  log('Statistics hidden');
});

// "Load More": asks WhatsApp Web to fetch older history, 5 rounds back to back.
// Only works against a single chat at a time.
loadMoreBtn?.addEventListener('click', async () => {
  const ids = getSelectedChatIds();
  if (ids.length !== 1) {
    log('Select exactly one chat to load more history for it.');
    return;
  }
  const selectedChatId = ids[0];

  const totalLoads = 5;
  log(`Loading older history (${totalLoads} rounds)...`);
  loadMoreBtn.disabled = true;

  for (let i = 1; i <= totalLoads; i++) {
    loadMoreBtn.textContent = `Loading ${i}/${totalLoads}...`;

    await sendToPage({
      __from: 'wamd:inpage',
      type: 'popup:cmd',
      cmd: 'loadMore',
      payload: { selectedChatId }
    });

    await new Promise(r => setTimeout(r, 6000));
    await loadChatStats();
  }

  loadMoreBtn.disabled = false;
  loadMoreBtn.textContent = 'Load more messages';
  log('Finished loading older history. Check the updated statistics.');
});

async function refreshChats() {
  chatSel.disabled = true;
  chatSel.innerHTML = `<option value="">Loading chats...</option>`;
  await sendToPage({ __from: 'wamd:inpage', type: 'popup:ready?' });
  await sendToPage({ __from: 'wamd:inpage', type: 'popup:cmd', cmd: 'listChats', payload: {} });
}

D('#refresh').addEventListener('click', refreshChats);

D('#start').addEventListener('click', async () => {
  const chatIds = getSelectedChatIds();

  if (!chatIds.length) {
    log('Select at least one chat from the list first.');
    chatSel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    chatSel.focus({ preventScroll: true });
    chatSel.classList.add('attn');
    setTimeout(() => chatSel.classList.remove('attn'), 1200);
    return;
  }

  const types = getTypes();
  if (!types.length) {
    log('Select at least one media type.');
    return;
  }

  const naming = {
    useDate: D('#useDate').checked,
    includeSenderName: D('#includeSenderName')?.checked ?? false,
    captionSuffix: D('#useCaptionSuffix').checked,
    appendOrigNameAll: D('#appendOrigNameAll')?.checked ?? true
  };

  const pack = {
    saveAsZip: D('#saveAsZip').checked,
    deepScan: !!D('#deepScan')?.checked,
    concurrency: Number(D('#concurrency')?.value) || 4
  };

  const dateFrom = D('#dateFrom').value || '';
  const dateTo = D('#dateTo').value || '';

  log(`Starting download. chats=${chatIds.length}, zip=${pack.saveAsZip}, parallel=${pack.concurrency}, types=[${types.join(',')}]`);
  progWrap.style.display = 'block';
  bar.style.width = '4%';

  await sendToPage({
    __from: 'wamd:inpage',
    type: 'popup:cmd',
    cmd: 'download',
    payload: { chatIds, types, dateFrom, dateTo, naming, pack }
  });
});

(async () => {
  try {
    const tab = await getActiveTab();
    await ensureInjected(tab.id);
    await refreshChats();
  } catch (e) {
    log('Init: ' + e.message);
  }
})();
