# Ingest Clients — Design Plan

**Status:** draft, not implemented. Revisit before building.

Companion software that gets media *into* Bunbooru from where users actually
find it: the desktop browser, the mobile share sheet, and the phone's camera
roll. Server-side hook design lives in [ingest-hooks.md](./ingest-hooks.md);
this doc covers the clients and the API surface they need.

---

## 1. Goal

Bunbooru is an image (later video) **backup and library server**. Capture must
be as close to one gesture as possible:

- **Desktop:** right-click an image → "Upload to Bunbooru" → done.
- **Mobile ad-hoc:** share sheet → Bunbooru → done.
- **Mobile bulk:** camera roll syncs in the background, no gesture at all.

### The friction rule

**Tagging must never be required at capture time.** Every quick-capture flow
dies on "now enter tags." Upload lands untagged into a *needs tagging* queue;
triage happens later in bulk from the web UI. Clients may *offer* tags
(the extension popup should), but must never block on them.

Content-hash dedupe (already in `asset-service`) makes this safe: re-sharing
the same image is idempotent, so users can be sloppy. Clients should surface
"already in your library" rather than an error.

---

## 2. Server-side prerequisites

Almost all of this is already built. What's missing:

| Need | Status |
|---|---|
| One-shot upload (`POST /assets`, multipart, dedupes on sha256) | **exists** |
| Resumable chunked upload (`POST/GET/DELETE /uploads[/:token]`) | **exists** |
| API keys | **exists** (`bnb_…`, sha256-stored) |
| Upload-scoped API key permission | **needed** |
| `POST /assets/exists` batch hash check | **needed** — see hooks doc §10 |
| `findManyBySha256` on the asset repository | **needed** |

`POST /assets/exists` returns four states per hash — `present | absent |
deleted | banned` — and is queried against `originalSha256` once transforms
exist. It is a batch hash oracle, so it requires auth and rate-limiting.

---

## 3. Browser extension (MV3)

The primary desktop surface, and the one that motivated this work.

### Decision: the extension uploads bytes, not a URL

Rejected alternative: a server-side `POST /assets/from-url`. It sounds simpler
but immediately fights the target site's auth, hotlink protection, Referer
checks, and signed/expiring URLs.

An extension's `fetch()` with `host_permissions` **bypasses CORS and sends the
site's cookies**, so the exact cases that defeat server-side fetching
(Pixiv, Twitter, Patreon, anything gated) are the cases the extension handles
trivially. The image already rendered, so the fetch is normally an HTTP cache
hit — no second download.

`from-url` stays on the roadmap, but as the *server-side ingest* path for
watch-folder / gallery-dl / bot plugins — not as the extension's mechanism.

### Decision: `Blob` + `FormData`, never base64

Base64 costs +33% on the wire, a full copy of the image as a JS string, and a
decode on the server. Unnecessary:

```js
const blob = await (await fetch(imgUrl, { credentials: "include" })).blob();
const fd = new FormData();
fd.append("file", blob, filename);
fd.append("source", pageUrl);
// → POST /assets, unchanged
```

This posts to the **existing** `POST /assets` — it already takes multipart
`t.File()`, already dedupes, already returns 200-vs-201. **The extension needs
zero new API surface.**

The reason base64 seems necessary is that `chrome.runtime.sendMessage` is
JSON-serialized and cannot carry a `Blob` between content script and service
worker. The fix is not to encode the bytes — it is to **never move bytes across
that boundary**: the content script sends the *URL*, the service worker does
both the fetch and the upload. Bytes are created and consumed in one context.

### Features

- Context menu on images/video/links → "Upload to Bunbooru"
- Popup: optional tags with autocomplete against the existing tag endpoint,
  pre-filled source URL + page title
- "Upload all images on this page" for gallery pages
- Options: server URL + API key

### Constraints to design around

**MV3 service workers get killed** (~30s idle, hard cap ~5min). Fine for
images; not for planned video. Anything large must go through the resumable
chunk endpoints so a killed worker resumes rather than restarts.

**When `fetch` genuinely fails** (rare — per-session signed URLs), do *not*
fall back to canvas: cross-origin images without CORS headers taint the canvas
and `toBlob` throws. Fall back to opening the upload page with the URL
prefilled for manual drag-drop.

---

## 4. Web app improvements

Small, cheap, independently useful:

- **Global paste handler** — `Ctrl+V` an image anywhere queues it. Covers
  screenshots, which no URL-based flow can.
- **Drag-and-drop** anywhere, not only on `/upload`.
- **Needs-tagging queue** — the triage view the friction rule depends on.

---

## 5. PWA share target (Android stopgap)

A `share_target` entry in the web manifest puts Bunbooru in the Android system
share sheet with **zero app-store involvement** — share from Chrome, Gallery,
or Telegram and it lands in the upload queue.

- Cost: a manifest entry plus one POST route. An afternoon.
- Add Background Sync so a share on bad signal still lands later.
- **iOS Safari does not support `share_target`.** This is Android-only, by
  platform limitation, not by choice.

Ships *before* the mobile app so mobile capture works while the app is built.
Nothing here is thrown away afterwards.

---

## 6. iOS Shortcut (interim)

Until the app exists, a share-sheet Shortcut hitting the API with an API key
covers iOS. Costs **no code** — a documented shortcut template users import
once. Same workaround Immich and Karakeep ship.

---

## 7. Mobile app

One app covering **share target + gallery sync**. This is the only way to get a
share extension on iOS at all, and the only way to get real background backup.
It is by far the largest item in this plan.

### Gallery sync is mostly already built

`sha256` is a unique content key with `findBySha256` in the repository, so sync
reduces to a stateless diff:

1. Enumerate the camera roll
2. Hash anything not in the local hash cache
3. Ask the server which hashes are missing (`POST /assets/exists`)
4. Upload only those

**This is stateless on purpose.** There is no "last synced" cursor to corrupt
or reset. Reinstall the app, restore the phone from backup, switch devices —
the diff recomputes from content and self-heals. Cursor-based sync breaks in
all three cases.

The expensive part is hashing, not uploading. `POST /assets/exists` turns a
20,000-photo first sync from ~80GB of uploads into ~40 requests of ~32KB.

### Local database

**A cache, never a source of truth.** Every inconsistency resolves by re-running
the hash diff — that property is what makes the design self-healing, and any
optimization that makes the local DB authoritative must be rejected.

```
localId, mtime, sizeBytes, sha256,
state,           -- discovered | hashed | uploaded | skipped_deleted
                 -- | skipped_banned | failed
serverAssetId,
lastVerifiedAt, attemptCount, lastError
```

Its real job is **avoiding rehashing**. Key on `(localId, mtime, size)`; if any
change, rehash — iOS edits create a new version of the asset in place.

Identity gotchas:

- **Android `MediaStore._ID` is not stable** across media rescans.
- **iOS `PHAsset.localIdentifier` is stable until restore-from-backup**, which
  reissues every identifier and effectively invalidates the whole local DB.

Both look catastrophic for cursor-based sync and are a non-event here: rehash,
diff, upload nothing because everything matches.

### Handling server-side deletion

The client must skip hashes the server reports as `deleted` or `banned`. Doing
otherwise causes the **zombie photo problem** — content the user deliberately
deleted silently resurrected by the next sync, forever. This is one of the most
common complaints against Google Photos and Immich-style backup.

This is why deletion needs tombstoned hashes server-side, and why `delete` and
`delete + ban` are separate actions (hooks doc §10).

### Re-verification

Don't re-diff the whole library on every app open. Verify newly-hashed items
immediately; re-verify the full set on a slow rolling schedule (a slice per
day, or explicit pull-to-refresh). Hashes are already cached, so re-verification
is pure network — cheap enough to run weekly.

### Network policy

- **Wi-Fi-only by default**, explicit cellular opt-in asked once at onboarding,
  never mid-sync.
- Detect **metered** connections, not just "is it Wi-Fi" — a tethered hotspot
  reports as Wi-Fi and bills like cellular. Android:
  `NET_CAPABILITY_NOT_METERED`. iOS: `NWPath.isExpensive` / `isConstrained`.
- Prefer a **size threshold** over a binary switch: "photos on cellular, videos
  on Wi-Fi only" is what people actually want, and matters much more with video.
- Charging/battery constraint for the initial bulk backfill.
- **Use the resumable chunk endpoints on cellular.** A dropped connection 90%
  through a 200MB video should resume, not restart.

Android is largely declarative — WorkManager `Constraints` covers
metered/charging/idle and survives reboots. iOS is manual.

### Platform realities

- **iOS background upload is opportunistic.** `BGProcessingTask` fires when iOS
  decides. Sync is "reliable while open, best-effort in background" — state
  that in the UI rather than promising continuous backup.
- **Android is genuinely reliable** (WorkManager + foreground service).
- **The iOS share extension needs native code** regardless of framework — a
  separate app target. `expo-share-extension` handles it, but that means an
  EAS/dev-client build, not Expo Go.

---

## 8. Later, as plugins

Each registers a background job; none touch Core.

- **`gallery-dl` / `yt-dlp`** — site-aware fetching (Pixiv, Twitter…). Brings
  original tags, artist, and post metadata. The path to video.
- **Watch folder** — inotify on `./data/inbox`. Also the target for a
  **Syncthing/rclone gallery-backup recipe**, which delivers cross-platform
  camera-roll backup with *no app development at all*. Worth shipping early as
  a hedge against the mobile app's cost.
- **`from-url`** — server-side fetch; the shared primitive under the above.
- **Telegram bot / email-to-upload / RSS pull** — trivial once `from-url` exists.

---

## 9. Build order

Ordered by value-per-effort, with server prerequisites first.

1. **Upload-scoped API key permission** — gates every headless client.
2. **`findManyBySha256` + `POST /assets/exists`** — four-state; unblocks sync.
   Depends on deletion + ban existing (hooks doc phases 2–4).
3. **Browser extension** — the stated primary scenario; needs no new API.
4. **Web app paste / drag-drop / needs-tagging queue** — small, independent.
5. **PWA `share_target`** — Android mobile capture, an afternoon.
6. **iOS Shortcut template** — documentation only.
7. **Watch-folder plugin + Syncthing recipe** — cheap cross-platform backup.
8. **Mobile app** — share target first, then gallery sync.
9. **`from-url` + `gallery-dl` plugin** — video and site-aware ingest.

Items 1–2 are server-side and belong with the hooks work. Items 3–6 are each
small enough to land independently. Item 8 is a project in its own right and
should not be started until 2 is settled — the sync contract is its foundation.

---

## 10. Open questions

1. Extension: Chrome-only first, or Firefox parity from the start?
2. Mobile framework: Expo/React Native vs. Capacitor vs. native. Driven mostly
   by the iOS share-extension and background-task story.
3. Does the extension reuse the web session cookie when same-origin, or always
   use an API key? (API key is simpler and works cross-origin.)
4. Should sync upload HEIC/Live Photos as-is, or transcode client-side?
   Interacts with the transform hooks and the dual-hash problem.
5. Per-device registration — do we want visible "devices" in account settings
   (revocable per-device API keys), or one key per user?
