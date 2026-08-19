# WhatSave

A free, open-source Chrome extension (Manifest V3) that bulk downloads media
from WhatsApp Web, images, videos, voice notes/audio, and documents, from one
or more chats at once, either as loose files or a single ZIP.

Built by [Jstarzz](https://github.com/Jstarzz). A star on the
[repo](https://github.com/Jstarzz/whatsave) helps other people find it.

## Features

- No limits and no license key. Everything is unlocked.
- Select multiple chats in the popup and it works through each one in turn.
- Files save through `chrome.downloads` (via the background service worker)
  rather than by clicking a hidden link inside the WhatsApp Web page. Chrome
  blocks a *page* from firing off a stream of automatic downloads but does
  not block an *extension* doing the same through its downloads API, which
  is what makes downloading many files back to back possible at all.
- Media is fetched fresh from WhatsApp instead of read out of whatever the
  page happens to have cached, so files save at their original quality.
- Downloads run 2, 4, 6, or 8 files at a time rather than strictly one.
- Individual files land in `Downloads/WA Media Downloads/<Chat Name>/...`
  instead of loose in your Downloads root.
- Progress reporting, a bounded log panel so a large batch does not bog down
  the popup, and "All types" / "Videos only" filter buttons.

## How it works

- `inpage/vendor/wppconnect-wa.js` is
  [WPPConnect `wa-js`](https://github.com/wppconnect-team/wa-js) v4.4.3,
  bundled unmodified. It gives the extension a supported way to read chats
  and messages from WhatsApp Web's own in-memory store. It is Apache-2.0,
  and the notices for it and everything it bundles are in
  `inpage/vendor/wppconnect-wa.js.LICENSE.txt`. Keep that file alongside it
  when redistributing, and check upstream for the current terms.
- `inpage/app.js` runs in the page's main world, uses `wa-js` to list chats,
  scan chats for media messages, and download each one's underlying blob.
- `content.js` bridges page and extension messages.
- `background.js` is the MV3 service worker. It is the only place that
  actually calls `chrome.downloads.download()`.
- `popup.html` / `popup.js` / `popup.css` are the toolbar UI.

## Installing it unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open [web.whatsapp.com](https://web.whatsapp.com), log in, then click the
   extension icon.

## Using it

1. Select one or more chats from the list (click **Update chat list** if
   nothing shows up yet).
2. Optionally set a date range, pick media types, and adjust naming options.
3. Optionally use **Load More Messages** first, for a single chat, if you
   need media further back than WhatsApp Web has already loaded locally.
4. Click **Download all**. Files save individually, or as one ZIP per chat
   if **Save as single ZIP** is checked.

## Notes and limits

- This only ever touches chats you already have open in your own WhatsApp
  Web session. It cannot access anything you do not already have access to.
- WhatsApp Web generally only keeps roughly a year of history loaded
  locally. **Load More Messages** nudges it to fetch further back, but very
  old media may already be gone from WhatsApp's servers.
- Media quality is whatever the sender's own device uploaded to WhatsApp.
  There is no separate hidden "HD" copy on the server for this extension to
  fetch instead, it downloads the same original file WhatsApp Web itself
  would show you.
- Very large batches will still take a while. Media has to be decrypted and
  fetched one file at a time from WhatsApp's side, the parallel-download
  setting only controls how many of those requests are in flight together.
- This project is not affiliated with, endorsed by, or associated with
  WhatsApp or Meta.

## Privacy

Nothing is collected, stored, or transmitted anywhere. See `PRIVACY.md`.

## License

MIT for the code in this repository (see `LICENSE`). That covers everything
except `inpage/vendor/`, which is third-party: `wa-js` is Apache-2.0, and
the libraries bundled inside it are MIT and BSD-3-Clause. Their notices ship
in `inpage/vendor/wppconnect-wa.js.LICENSE.txt` and are not relicensed by
the MIT grant above.
