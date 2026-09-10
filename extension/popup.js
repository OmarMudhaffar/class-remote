'use strict';

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

const MODE_LABEL = { slides: 'Arrow keys', doc: 'Page keys', video: 'Video keys' };

function drawQR(url) {
  const box = $('qr');
  box.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
  } catch (e) {
    box.textContent = 'QR unavailable';
  }
}

async function paint() {
  const res = await send({ type: 'status' });
  const S = res && res.state;
  const cfg = (res && res.cfg) || {};
  if (!$('remoteBase').value) $('remoteBase').value = cfg.remoteBase || '';
  if (!$('db').value) $('db').value = cfg.db || '';

  const live = !!(S && S.active);
  $('idle').classList.toggle('hide', live);
  $('live').classList.toggle('hide', !live);
  $('dot').classList.toggle('live', live);
  $('dotText').textContent = live ? 'live' : 'idle';

  if (live) {
    $('target').textContent = S.title || S.name;
    $('targetSub').textContent = S.name + ' · ' + (MODE_LABEL[S.mode] || '');
    $('code').textContent = S.code;
    $('link').textContent = res.remoteUrl;
    drawQR(res.remoteUrl);
    $('holder').textContent = S.holder ? ('Remote held by ' + S.holder) : 'Nobody has picked it up yet.';
    const limited = S.driver !== 'debugger';
    $('warn').classList.toggle('hide', !limited);
    if (limited) {
      $('warn').innerHTML =
        'Running without real key input, so PDFs will not turn. ' +
        'Reload the tab and start again, and leave the debugging banner alone.';
    }
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('target').textContent = (tab && tab.title) || 'This tab';
    $('targetSub').textContent = (tab && tab.url) ? new URL(tab.url).hostname || tab.url : '';
  }

  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('on', live && c.dataset.mode === S.mode);
  });
}

$('start').addEventListener('click', async () => {
  $('start').textContent = 'Starting…';
  const r = await send({ type: 'start' });
  if (!r || !r.ok) {
    $('start').textContent = 'Start session';
    alert('Could not start: ' + ((r && r.error) || 'unknown error'));
    return;
  }
  await paint();
});

$('stop').addEventListener('click', async () => {
  await send({ type: 'stop' });
  $('start').textContent = 'Start session';
  await paint();
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('link').textContent).catch(() => {});
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy link'), 1200);
});

$('rotate').addEventListener('click', async () => {
  await send({ type: 'rotate' });
  await paint();
});

$('big').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('session.html') });
});

document.querySelectorAll('.chip').forEach((c) => {
  c.addEventListener('click', async () => {
    await send({ type: 'setMode', mode: c.dataset.mode });
    await paint();
  });
});

$('save').addEventListener('click', async () => {
  await send({
    type: 'saveCfg',
    db: $('db').value.trim().replace(/\/+$/, ''),
    remoteBase: $('remoteBase').value.trim()
  });
  $('save').textContent = 'Saved';
  setTimeout(() => ($('save').textContent = 'Save'), 1200);
  await paint();
});

paint();
setInterval(paint, 2500);
