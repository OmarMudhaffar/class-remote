'use strict';

/* ------------------------------------------------------------------ *
 * Class Remote — offscreen channel.
 *
 * A service worker is killed after ~30s idle and has no EventSource, so
 * the live connection cannot live there. This page holds it instead and
 * forwards each command to the worker (which the message itself wakes).
 * ------------------------------------------------------------------ */

let es = null;
let poll = null;
let hb = null;
let cur = { db: '', code: '' };
let lastSeen = 0;
let failures = 0;

function stop() {
  if (es) { try { es.close(); } catch (e) {} es = null; }
  if (poll) { clearInterval(poll); poll = null; }
  if (hb) { clearInterval(hb); hb = null; }
}

function forward(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (typeof payload.n === 'number') {
    if (payload.n <= lastSeen) return;
    lastSeen = payload.n;
  }
  chrome.runtime.sendMessage({ type: 'cmd', payload }).catch(() => {});
}

function connect(db, code) {
  stop();
  cur = { db: db.replace(/\/+$/, ''), code };
  lastSeen = 0;
  failures = 0;

  const url = cur.db + '/sessions/' + code + '/cmd.json';

  try {
    es = new EventSource(url);
    es.addEventListener('put', (e) => {
      failures = 0;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      forward(msg && msg.data);
    });
    es.addEventListener('patch', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      forward(msg && msg.data);
    });
    es.onerror = () => {
      failures++;
      // EventSource retries on its own; after a few misses fall back to
      // polling so a flaky campus network cannot kill the remote.
      if (failures >= 3 && !poll) startPolling();
    };
  } catch (e) {
    startPolling();
  }

  // Waking the worker on a timer keeps the published "host is up" fresh,
  // which is what the phone shows as its connection dot.
  hb = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'hb' }).catch(() => {});
  }, 20000);
}

function startPolling() {
  if (poll) return;
  poll = setInterval(async () => {
    if (!cur.db || !cur.code) return;
    try {
      const r = await fetch(cur.db + '/sessions/' + cur.code + '/cmd.json?_=' + Date.now(),
                            { cache: 'no-store' });
      if (!r.ok) return;
      forward(await r.json());
    } catch (e) { /* keep trying */ }
  }, 700);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.to !== 'offscreen') return;
  if (msg.type === 'connect') {
    if (msg.code && (msg.code !== cur.code || msg.db !== cur.db || (!es && !poll))) {
      connect(msg.db, msg.code);
    }
    reply({ ok: true });
  } else if (msg.type === 'disconnect') {
    stop();
    reply({ ok: true });
  }
  return true;
});
