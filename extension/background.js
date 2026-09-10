'use strict';

/* ------------------------------------------------------------------ *
 * Class Remote — background service worker.
 *
 * Owns the session (code, target tab, input driver) and turns commands
 * arriving from the phone into real key presses on the presenting tab.
 * ------------------------------------------------------------------ */

const DEFAULTS = {
  db: 'https://heaft-app-default-rtdb.firebaseio.com',
  remoteBase: 'https://omarmudhaffar.github.io/class-remote/'
};

/* Virtual key codes matter: Chrome's PDF viewer and Office Online read the
   raw key code, not the JS `key` string, so both have to be right. */
const KEY = {
  ArrowRight: { vk: 39,  code: 'ArrowRight', key: 'ArrowRight' },
  ArrowLeft:  { vk: 37,  code: 'ArrowLeft',  key: 'ArrowLeft'  },
  ArrowDown:  { vk: 40,  code: 'ArrowDown',  key: 'ArrowDown'  },
  ArrowUp:    { vk: 38,  code: 'ArrowUp',    key: 'ArrowUp'    },
  PageDown:   { vk: 34,  code: 'PageDown',   key: 'PageDown'   },
  PageUp:     { vk: 33,  code: 'PageUp',     key: 'PageUp'     },
  Home:       { vk: 36,  code: 'Home',       key: 'Home'       },
  End:        { vk: 35,  code: 'End',        key: 'End'        },
  Space:      { vk: 32,  code: 'Space',      key: ' ',  text: ' ' },
  KeyB:       { vk: 66,  code: 'KeyB',       key: 'b',  text: 'b' },
  KeyK:       { vk: 75,  code: 'KeyK',       key: 'k',  text: 'k' }
};

/* Which keys mean "forward" depends on what is on screen. Decks answer to
   the arrows; documents and the PDF viewer answer to the page keys. */
const MOVES = {
  slides: { next: 'ArrowRight', prev: 'ArrowLeft', first: 'Home', last: 'End', blank: 'KeyB' },
  doc:    { next: 'PageDown',   prev: 'PageUp',    first: 'Home', last: 'End', blank: null    },
  video:  { next: 'ArrowRight', prev: 'ArrowLeft', first: 'Home', last: 'End', blank: 'KeyK'  },
  // pdf drives the viewer by page number instead of by key; these are the
  // fallback presses for anything the fragment navigation cannot express.
  pdf:    { next: 'PageDown',   prev: 'PageUp',    first: 'Home', last: 'End', blank: null    }
};

const PROFILES = [
  { re: /^https?:\/\/docs\.google\.com\/presentation/i,               mode: 'slides', name: 'Google Slides' },
  { re: /^https?:\/\/docs\.google\.com\/document/i,                   mode: 'doc',    name: 'Google Docs' },
  { re: /^https?:\/\/docs\.google\.com\/spreadsheets/i,               mode: 'doc',    name: 'Google Sheets' },
  { re: /^https?:\/\/drive\.google\.com\/.*\/preview/i,               mode: 'doc',    name: 'Drive preview' },
  { re: /powerpoint|\/:p:\/|officeapps\.live\.com.*Powerpoint/i,      mode: 'slides', name: 'PowerPoint' },
  { re: /^https?:\/\/[^/]*(office|sharepoint|onedrive)\.[^/]+\//i,    mode: 'doc',    name: 'Office Online' },
  { re: /^https?:\/\/(www\.)?canva\.com/i,                            mode: 'slides', name: 'Canva' },
  { re: /^https?:\/\/(www\.)?prezi\.com/i,                            mode: 'slides', name: 'Prezi' },
  { re: /^https?:\/\/(www\.)?figma\.com\/(deck|slides|proto)/i,       mode: 'slides', name: 'Figma' },
  { re: /^https?:\/\/(www\.)?(pitch\.com|slides\.com|slideshare)/i,   mode: 'slides', name: 'Web deck' },
  { re: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)/i,   mode: 'video',  name: 'Video' },
  { re: /^https?:\/\/(www\.)?notion\.(so|site)/i,                     mode: 'doc',    name: 'Notion' },
  { re: /^https?:\/\/(www\.)?overleaf\.com/i,                         mode: 'doc',    name: 'Overleaf' }
];

/* Session state. Kept in chrome.storage.session so a service-worker
   restart doesn't lose the running session. */
let S = null;

async function loadState() {
  if (S) return S;
  const got = await chrome.storage.session.get('S');
  S = got.S || null;
  return S;
}
async function saveState() {
  await chrome.storage.session.set({ S });
}
async function settings() {
  const got = await chrome.storage.local.get(['db', 'remoteBase']);
  return { db: got.db || DEFAULTS.db, remoteBase: got.remoteBase || DEFAULTS.remoteBase };
}

/* ---------- target detection --------------------------------------- */

function detect(url = '') {
  if (/^file:\/\/.*\.pdf(\?|#|$)/i.test(url) || /\.pdf(\?|#|$)/i.test(url)) {
    return { mode: 'pdf', name: 'PDF' };
  }
  for (const p of PROFILES) if (p.re.test(url)) return { mode: p.mode, name: p.name };
  return { mode: 'doc', name: 'Page' };
}

/* ---------- input drivers ------------------------------------------ *
 * debugger  : Input.dispatchKeyEvent -> a real, trusted key press. The only
 *             thing that reaches Chrome's PDF viewer, which is an internal
 *             plugin no content script can touch.
 * synthetic : a KeyboardEvent dispatched from a content script. Untrusted,
 *             so it only moves JS-driven decks — but it needs no debugger
 *             attachment, and therefore shows no infobar.
 * ------------------------------------------------------------------- */

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    return true;
  } catch (e) {
    console.warn('[ClassRemote] debugger attach failed:', e && e.message);
    return false;
  }
}

async function detachDebugger(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already gone */ }
}

async function sendKeyDebugger(tabId, name) {
  const k = KEY[name];
  if (!k) return false;
  const base = {
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    code: k.code,
    key: k.key,
    isSystemKey: false
  };
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
      Object.assign({ type: k.text ? 'keyDown' : 'rawKeyDown' }, base, k.text ? { text: k.text } : {}));
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent',
      Object.assign({ type: 'keyUp' }, base));
    return true;
  } catch (e) {
    console.warn('[ClassRemote] dispatch failed:', e && e.message);
    return false;
  }
}

function synthInPage(k) {
  const opts = {
    key: k.key, code: k.code, keyCode: k.vk, which: k.vk,
    bubbles: true, cancelable: true, composed: true
  };
  for (const t of [document.activeElement || document.body, document, window]) {
    try {
      t.dispatchEvent(new KeyboardEvent('keydown', opts));
      t.dispatchEvent(new KeyboardEvent('keyup', opts));
    } catch (e) { /* ignore */ }
  }
  // Documents that ignore synthetic keys still scroll.
  if (k.code === 'PageDown') window.scrollBy({ top: window.innerHeight * 0.92, behavior: 'smooth' });
  if (k.code === 'PageUp')   window.scrollBy({ top: -window.innerHeight * 0.92, behavior: 'smooth' });
}

async function sendKeySynthetic(tabId, name) {
  const k = KEY[name];
  if (!k) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: synthInPage,
      args: [k]
    });
    return true;
  } catch (e) {
    console.warn('[ClassRemote] synthetic failed:', e && e.message);
    return false;
  }
}

async function press(name) {
  if (!S || !S.tabId || !name) return false;
  if (S.driver === 'debugger') {
    const ok = await sendKeyDebugger(S.tabId, name);
    if (ok) return true;
    S.driver = 'synthetic';          // attachment died mid-session
    await saveState();
  }
  return sendKeySynthetic(S.tabId, name);
}

/* ---------- pdf: move by page, not by viewport ----------------------- *
 * Chrome opens PDFs fit to WIDTH, so a page is taller than the window and
 * PageDown scrolls a screenful — landing halfway between two pages. Asking
 * the viewer for a page number instead is exact at any zoom, and view=Fit
 * sizes each page to the window so one tap shows one whole page.
 * ------------------------------------------------------------------- */

function pageFromUrl(url) {
  const m = /[#&]page=(\d+)/.exec(url || '');
  return m ? parseInt(m[1], 10) : null;
}

async function pdfGoto(n) {
  const page = Math.max(1, n);
  try {
    const tab = await chrome.tabs.get(S.tabId);
    const base = (tab.url || S.url).split('#')[0];
    await chrome.tabs.update(S.tabId, { url: base + '#page=' + page + '&view=Fit' });
    S.page = page;
    return true;
  } catch (e) {
    console.warn('[ClassRemote] pdf navigation failed:', e && e.message);
    return false;
  }
}

/* ---------- blank / fullscreen -------------------------------------- */

function blankOverlay() {
  const ID = '__class_remote_blank__';
  const old = document.getElementById(ID);
  if (old) { old.remove(); return; }
  const d = document.createElement('div');
  d.id = ID;
  d.style.cssText =
    'position:fixed;inset:0;background:#000;z-index:2147483647;cursor:none';
  document.documentElement.appendChild(d);
}

async function doBlank() {
  const move = MOVES[S.mode] || MOVES.doc;
  if (move.blank) { await press(move.blank); return; }
  try {
    await chrome.scripting.executeScript({ target: { tabId: S.tabId }, func: blankOverlay });
  } catch (e) {
    console.warn('[ClassRemote] blank unavailable on this tab');
  }
}

async function doFullscreen() {
  try {
    const tab = await chrome.tabs.get(S.tabId);
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, {
      state: win.state === 'fullscreen' ? 'maximized' : 'fullscreen'
    });
  } catch (e) { /* window gone */ }
}

/* ---------- command execution --------------------------------------- */

async function run(cmd) {
  await loadState();
  if (!S || !S.active) return;
  if (typeof cmd.n === 'number') {
    if (cmd.n <= (S.lastN || 0)) return;   // replayed on reconnect — ignore
    S.lastN = cmd.n;
  }
  S.lastAt = Date.now();

  const move = MOVES[S.mode] || MOVES.doc;
  const pdf = S.mode === 'pdf';
  if (pdf && S.page == null) S.page = 1;
  switch (cmd.a) {
    case 'next':  if (!(pdf && await pdfGoto(S.page + 1))) await press(move.next); break;
    case 'prev':  if (!(pdf && await pdfGoto(S.page - 1))) await press(move.prev); break;
    case 'first': if (!(pdf && await pdfGoto(1)))          await press(move.first); break;
    // Nothing tells us the page count, so the end of a PDF is still a key press.
    case 'last':  await press(move.last); break;
    case 'blank': await doBlank(); break;
    case 'full':  await doFullscreen(); break;
    case 'mode':
      if (MOVES[cmd.mode]) { S.mode = cmd.mode; S.name = cmd.mode === 'slides' ? 'Slides' : cmd.mode === 'video' ? 'Video' : 'Document'; }
      break;
    default: break;
  }
  await saveState();
  await publishState();
}

/* ---------- Firebase channel ---------------------------------------- */

async function dbPut(path, value) {
  const { db } = await settings();
  try {
    await fetch(db + path + '.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
    return true;
  } catch (e) {
    console.warn('[ClassRemote] db write failed:', e && e.message);
    return false;
  }
}

async function publishState() {
  if (!S || !S.active) return;
  await dbPut('/sessions/' + S.code + '/host', {
    up: true,
    mode: S.mode,
    name: S.name,
    driver: S.driver,
    page: S.page || null,
    lastAt: S.lastAt || null,
    t: Date.now()
  });
}

/* The offscreen document exists for exactly one reason: a service worker is
   torn down after ~30s idle and has no EventSource, so it cannot hold the
   live channel open. The offscreen page can. */
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;
  const args = {
    url: 'offscreen.html',
    justification: 'Holds the live connection to the phone remote channel.'
  };
  try {
    await chrome.offscreen.createDocument(Object.assign({ reasons: ['WORKERS'] }, args));
  } catch (e) {
    await chrome.offscreen.createDocument(Object.assign({ reasons: ['DOM_SCRAPING'] }, args))
      .catch(err => console.warn('[ClassRemote] offscreen failed:', err && err.message));
  }
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch (e) { /* none open */ }
}

async function tellOffscreen(msg) {
  try { await chrome.runtime.sendMessage(Object.assign({ to: 'offscreen' }, msg)); }
  catch (e) { /* not up yet */ }
}

/* ---------- session lifecycle ---------------------------------------- */

function makeCode() {
  // No 0/O/1/I — these get read off a projector and typed by hand.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

async function startSession(tabId) {
  await stopSession({ quiet: true });

  const tab = tabId ? await chrome.tabs.get(tabId)
                    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) throw new Error('No tab to control.');

  const target = detect(tab.url || '');
  const code = makeCode();

  const ok = await attachDebugger(tab.id);
  S = {
    active: true,
    code,
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    mode: target.mode,
    name: target.name,
    driver: ok ? 'debugger' : 'synthetic',
    lastN: 0,
    startedAt: Date.now()
  };
  await saveState();

  if (target.mode === 'pdf') {
    S.page = pageFromUrl(tab.url) || 1;
    await pdfGoto(S.page);          // same page, now fitted to the window
  }
  await saveState();

  await dbPut('/sessions/' + code, { cmd: { a: 'hello', n: 0, t: Date.now() }, host: null });
  await publishState();
  await ensureOffscreen();
  await tellOffscreen({ type: 'connect', code, db: (await settings()).db });

  await chrome.alarms.create('watchdog', { periodInMinutes: 1 });
  chrome.action.setBadgeText({ text: code.slice(0, 2) });
  chrome.action.setBadgeBackgroundColor({ color: '#1FD98A' });
  return S;
}

async function stopSession(opts = {}) {
  await loadState();
  if (S) {
    if (S.driver === 'debugger') await detachDebugger(S.tabId);
    if (S.code) await dbPut('/sessions/' + S.code + '/host', { up: false, t: Date.now() });
  }
  await tellOffscreen({ type: 'disconnect' });
  await closeOffscreen();
  await chrome.alarms.clear('watchdog');
  chrome.action.setBadgeText({ text: '' });
  S = null;
  await saveState();
  if (!opts.quiet) { /* nothing else to do */ }
}

/* ---------- wiring ---------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.to === 'offscreen') return;   // not ours

  (async () => {
    await loadState();
    switch (msg.type) {
      case 'cmd':                     // from the offscreen channel
        await run(msg.payload || {});
        reply({ ok: true });
        break;
      case 'status': {
        const cfg = await settings();
        reply({
          state: S,
          remoteUrl: S ? cfg.remoteBase + '#' + S.code : null,
          cfg
        });
        break;
      }
      case 'start':
        try { reply({ ok: true, state: await startSession(msg.tabId) }); }
        catch (e) { reply({ ok: false, error: String(e.message || e) }); }
        break;
      case 'stop':
        await stopSession();
        reply({ ok: true });
        break;
      case 'rotate':
        // Everyone who scanned the old code loses the room. The point of
        // handing out a link is that you can take it back.
        if (S && S.active) {
          await dbPut('/sessions/' + S.code + '/host', { up: false, t: Date.now() });
          S.code = makeCode();
          S.lastN = 0;
          S.lastAt = null;
          await saveState();
          await dbPut('/sessions/' + S.code, { cmd: { a: 'hello', n: 0, t: Date.now() }, host: null });
          await publishState();
          await ensureOffscreen();
          await tellOffscreen({ type: 'connect', code: S.code, db: (await settings()).db });
          chrome.action.setBadgeText({ text: S.code.slice(0, 2) });
        }
        reply({ ok: true, state: S });
        break;
      case 'setMode':
        if (S && MOVES[msg.mode]) { S.mode = msg.mode; await saveState(); await publishState(); }
        reply({ ok: true, state: S });
        break;
      case 'saveCfg':
        await chrome.storage.local.set({ db: msg.db, remoteBase: msg.remoteBase });
        reply({ ok: true });
        break;
      case 'hb':                      // offscreen heartbeat
        await publishState();
        reply({ ok: true });
        break;
      default:
        reply({ ok: false });
    }
  })();
  return true;                        // async reply
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-session') return;
  await loadState();
  if (S && S.active) await stopSession();
  else await startSession();
});

/* If the presenting tab goes away, so does the session. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (S && S.tabId === tabId) await stopSession();
});

/* The user can cancel the debugger banner. Drop to synthetic rather than die. */
chrome.debugger.onDetach.addListener(async (src) => {
  await loadState();
  if (S && src.tabId === S.tabId && S.driver === 'debugger') {
    S.driver = 'synthetic';
    await saveState();
    await publishState();
  }
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'watchdog') return;
  await loadState();
  if (!S || !S.active) return;
  await ensureOffscreen();
  await tellOffscreen({ type: 'connect', code: S.code, db: (await settings()).db });
  await publishState();
});

chrome.runtime.onStartup.addListener(() => stopSession({ quiet: true }));
