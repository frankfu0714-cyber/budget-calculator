# SplitCalc — Event Splitter · 分帳 · 麻將 · 結算

A single-page, zero-account web app for splitting event costs, tallying mahjong scores, and settling group expenses. Bilingual (English / 中文), works offline, and shareable via link or live-sync room.

Live: <https://frankfu0714-cyber.github.io/budget-calculator/>

## Tabs

- **Event Splitter (分帳)** — Split lump costs across N people with per-item overrides, foreign-currency conversion, and "I paid this" tracking to see what to collect.
- **Mahjong (麻將)** — Score self-drawn / discard wins, track rounds, and see a settlement 結算 showing who pays whom.
- **Expense Settlement (分帳結算)** — Classic group-expense splitter (like Splitwise) with participants, tax/tip/service charge, and equal or custom splits.

## Share links

Each tab has a share button. Data is compressed with LZString and encoded into the URL hash (`#e=…`, `#mj=…`, `#sx=…`), so nothing hits a server. Legacy links using query strings (`?e=…`, `?mj=…`, `?sx=…`) still resolve.

## Live rooms

Click **Room** to create or join a 6-character room code. Everyone with the code sees edits in real time via Firebase Realtime Database. No account required. Rooms auto-expire after 30 days of inactivity.

## Stack

Everything is in a single `index.html`. No build step. Runtime dependencies (loaded from CDN):

- LZString (share-link compression)
- Firebase Realtime Database (live rooms)
- Inter font (Google Fonts)

Also in the repo:

- `manifest.webmanifest` + `icon.svg` — PWA install support
- `firebase-rules.json` — RTDB security rules (see below)

## Firebase security rules

`firebase-rules.json` is the source of truth for the RTDB rules protecting live rooms. After changing that file, paste its contents into **Firebase Console → Realtime Database → Rules** and publish.

The rules:

- Deny root-level reads (nobody can enumerate all rooms).
- Allow read/write on `rooms/{code}` for anyone who knows the code.
- Require every room to have `meta/createdAt` — powers the TTL cleanup.
- Validate types and length caps on numeric / string fields to keep payloads sane.

## Development

Open `index.html` in a browser — that's it. To test the PWA / manifest, serve it over `http://localhost` (e.g. `python3 -m http.server`) so the browser will accept the `manifest.webmanifest`.
