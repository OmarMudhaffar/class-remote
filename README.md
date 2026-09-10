# Class Remote

Whoever is presenting gets a link on their phone. Tapping it moves whatever the
laptop is showing — a PDF, Google Slides, PowerPoint, a Word doc, a video.
No dongle, no pairing, no app to install on the phone.

```
phone (…/class-remote/#K7QM)  ──►  Firebase RTDB  ──►  Chrome extension  ──►  real key press
```

---

## 1. Install the extension

1. `chrome://extensions` → turn on **Developer mode** (top right)
2. **Load unpacked** → pick the `extension/` folder
3. Pin the icon so you can reach it during class

### Turn off the debugging banner (do this once)

The extension presses keys through Chrome's debugger, which is the only way to
reach the built-in PDF viewer. Chrome announces that with a yellow bar across
the top of the screen — fine on your laptop, ugly on a projector. Launch Chrome
once with the flag that silences it:

```bash
open -a "Google Chrome" --args --silent-debugger-extension-api
```

Quit Chrome fully first, or the flag is ignored. To make it permanent, put that
in a shell alias or a Shortcut.

## 2. Put the remote page somewhere phones can reach

`index.html` is one self-contained file — it is what GitHub Pages serves.

It is live at **https://omarmudhaffar.github.io/class-remote/** — push to `main`
and Pages redeploys in about a minute.

If you would rather serve it off your own domain, it is a single static file —
copy it anywhere that serves HTML over HTTPS. Phones need HTTPS for the camera
to open the link from a QR code. Whatever URL you use, set it in the extension
popup under **Settings**.

## 3. Lock down the database (do this once — it is currently wide open)

The Firebase RTDB accepts reads and writes from anyone, and `GET /sessions.json`
lists every live session code. Anyone who found the URL could read your code and
take over the projector. In the Firebase console → Realtime Database → Rules,
paste:

```json
{
  "rules": {
    "decks": { ".read": true, ".write": true },
    "sessions": {
      "$code": {
        ".read": true,
        ".write": true,
        ".validate": "$code.length === 4"
      }
    }
  }
}
```

This keeps the remote working — you can still read and write a session you know
the code for — but you can no longer list codes, and nothing can be written
anywhere else in the database. `decks` stays open because the pitch deck remote
uses it.

---

## Using it in class

1. Open the PDF or deck in a tab, and start presenting.
2. Click the extension icon → **Start session**.
3. **Show big** puts a full-screen QR on the laptop. The student scans it and
   they have the remote — no name to type, no app to install.
4. **New code** kicks everyone off and issues a fresh one. Use it between
   presenters so the last person cannot keep clicking.
5. **End session** detaches everything.

Keyboard shortcut to start/stop without the popup: <kbd>⌥⇧R</kbd>.

## What it drives

The extension reads the tab and picks the right keys. It never guesses blindly —
decks get the arrows, documents get the page keys.

| On screen | Mode | Forward / back |
|---|---|---|
| PDF (Chrome viewer, local or online) | pdf | PageDown / PageUp |
| Google Slides | slides | → / ← |
| PowerPoint & SharePoint | slides | → / ← |
| Google Docs, Sheets, Office Online | document | PageDown / PageUp |
| Canva, Prezi, Figma decks, web decks | slides | → / ← |
| YouTube, Vimeo | video | → / ← |
| Notion, Overleaf, Drive previews | document | PageDown / PageUp |
| Anything else | document | PageDown / PageUp |

Got it wrong? Tap a different mode in the popup — it applies instantly.

### Getting one whole page per tap on a PDF

Chrome opens a PDF fit to **width**, so a page is taller than the window and
PageDown scrolls a screenful — leaving you looking at the bottom of one page and
the top of the next. The fix is on the viewer, not the remote: click the
**presentation button** in Chrome's PDF toolbar (the ⛶ icon, top right) before
you start. Each page then fills the screen and one tap moves exactly one page.

The extension also asks for `#page=N&view=Fit` when a session opens, which
Chrome honours on load. It cannot do more than that: changing the fragment on an
already-open PDF does not move the viewer, and `chrome.tabs.update` reports
success regardless — so keys, not page numbers, are what drive a PDF here.

## Known limits

- **The end of a PDF is a key press, not a jump.** Nothing exposes the page
  count, so **End** sends the End key rather than a page number.
- **Blank does not work on a PDF.** In a deck it sends `B`, which is what
  PowerPoint and Slides listen for. Chrome's PDF viewer has no such key, and no
  extension can paint over it. Everywhere else it drops a black overlay.
- **If the banner is cancelled**, the extension falls back to synthetic key
  events. Those still move Google Slides and web decks, but not PDFs. The popup
  warns you when it has dropped to that mode.
- **Local PDFs** (`file://…`) need *Allow access to file URLs* switched on for
  the extension in `chrome://extensions`.
- **Anyone with the code can tap.** That is the point — it is a classroom, not a
  bank. Scanning the QR is the whole handshake, so there is nothing to identify
  who is tapping; **New code** is how you take the room back.

## How it is put together

```
extension/
  manifest.json     MV3
  background.js     session, target detection, the key drivers
  offscreen.js      holds the live connection (see below)
  popup.*           control panel: code, QR, mode, rotate
  session.*         full-screen QR for the projector
  vendor/qrcode.js  QR encoder, bundled — MV3 forbids remote scripts
index.html          the phone page, one file — served by GitHub Pages
```

Two things are load-bearing and non-obvious:

**The offscreen document.** An MV3 service worker is killed after ~30 seconds
idle and has no `EventSource` at all, so the live connection cannot live there.
`offscreen.js` holds it and forwards each command to the worker, which the
message itself wakes. Without this the remote works for half a minute and then
dies intermittently.

**Server timestamps.** Every command is written with `{".sv": "timestamp"}` so
Firebase stamps the ordering counter, not the phone. A student whose clock is
three minutes slow would otherwise have every tap ignored as a replay.
