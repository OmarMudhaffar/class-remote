'use strict';

let shown = '';

function draw(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  document.getElementById('qr').innerHTML =
    qr.createSvgTag({ cellSize: 8, margin: 1, scalable: true });
}

function paint() {
  chrome.runtime.sendMessage({ type: 'status' }, (res) => {
    const S = res && res.state;
    if (!S || !S.active) {
      document.getElementById('code').textContent = '––––';
      document.getElementById('url').textContent = '';
      document.getElementById('hint').className = 'hint off';
      document.getElementById('hint').textContent =
        'No session running. Open the extension on the tab you are presenting and press Start.';
      document.getElementById('qr').innerHTML = '';
      shown = '';
      return;
    }
    document.getElementById('code').textContent = S.code;
    document.getElementById('url').textContent = res.remoteUrl;
    document.getElementById('hint').className = 'hint';
    document.getElementById('hint').textContent =
      S.holder ? (S.holder + ' has the remote.')
               : 'Open it on your phone. Tap the bottom half to go forward.';
    if (res.remoteUrl !== shown) { draw(res.remoteUrl); shown = res.remoteUrl; }
  });
}

paint();
setInterval(paint, 2000);
