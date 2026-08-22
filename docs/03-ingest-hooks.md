# Ingest Hooks — Design Plan

**Status:** draft, not implemented. Revisit before building.

Adds plugin-extensible hook points around the asset ingest pipeline so features
like hash bans, EXIF stripping, and AI auto-tagging live in plugins instead of
Core — per CLAUDE.md's Core Rule and Plugin Rule.

---

## 1. Goals

- Let a plugin **reject** an ingest (banned hashes, quotas, file-type policy).
- Let a plugin **rewrite the bytes** before they are stored (EXIF/metadata strip).
- Keep the existing **fire-and-forget post-ingest** path for async work
  (thumbnails, AI tagging, OCR).
- Guarantee coverage of **every** upload source by construction, not by
  discipline.

### Non-goals

- Content moderation. A hash ban stops *byte-identical* re-uploads only; any
  re-encode defeats it. Perceptual/similarity matching is a separate, later,
  background-job feature.
- Mutating an asset's bytes *after* it has been persisted (see §7).

---

## 2. Why the ingest pipeline is the right seam

`packages/core/src/services/asset-service.ts` has a single private `ingest()`
function. Every upload source funnels through it:

- `POST /assets` (one-shot multipart)
- `POST /uploads/:token` (resumable chunked)
- `plugins/shimmie-import`
- any future watch-folder / gallery-dl / from-url plugin

A hook placed inside `ingest()` therefore covers all sources **by
construction** — a new ingest plugin cannot forget to call it. A hook placed in
a route handler could not make that guarantee.

### Current order

```text
hash (sha256 + md5, one streaming pass)
  → dedupe on sha256
  → sniff (Bun.Image metadata, maxPixels bomb guard)
  → store (move fast-path or stream)
  → insert
  → emit asset.created
```

---

## 3. Hook taxonomy

Three distinct kinds. Conflating them is the main design risk.

| Kind | Timing | Can veto | Can mutate bytes | Awaited | Failure default |
|---|---|---|---|---|---|
| `ingest.guard` | after hash, before store | yes | no | yes | **fail-closed** |
| `ingest.transform` | before store | no | yes | yes | **fail-open** |
| `asset.created` | after insert | no | no | no (fire-and-forget) | isolated |

`asset.created` already exists (`packages/core/src/events/index.ts`) and needs
no change. Only the two pre-ingest kinds are new.

### Why guards and transforms are separate

A guard answers *"may this in?"* and must be able to say no. A transform
answers *"what exactly gets stored?"* and must not be able to say no — a broken
EXIF stripper should never block uploads. They also want opposite failure
defaults (§6), which alone justifies separate types.

### Why the event bus can't do this

`CoreEvents` is a fire-and-forget `TypedEventEmitter`; listeners are
error-isolated and their return values are discarded. There is no way for a
listener to refuse or alter an ingest. Guards/transforms are a **new SDK
primitive**, not a new event.

---

## 4. Proposed pipeline order

```text
  hash original           → originalSha256, md5     (streaming, cheap)
→ guard(originalSha256)   → may reject (403)
→ transform(bytes)        → may rewrite the blob
→ re-hash IF transformed  → sha256 (storage identity)
→ dedupe on sha256
→ sniff
→ store
→ insert
→ emit asset.created
```

Two deliberate choices:

**Guard runs on the ORIGINAL hash, before transform.** Transforms decode and
re-encode — expensive. Rejecting a banned upload should cost one streaming hash
and one index lookup, never a decode. It also means the ban list is expressed
in terms of hashes a *client* can compute (§5).

**Re-hash only when a transform actually changed the bytes.** With no
transforms registered — the default — this is byte-for-byte the pipeline that
exists today, at identical cost. Hooks are zero-overhead when unused.

---

## 5. The dual-hash problem

**This is the subtlest interaction in the design and the main reason to write
it down before building.**

If a transform rewrites bytes, the stored `sha256` is the hash of the
*transformed* bytes. But the planned mobile gallery sync (`POST /assets/exists`)
has the client hash the **original** file on the device. Those hashes differ, so:

1. Client hashes local photo → `abc…`
2. Server stripped EXIF at ingest and stored `def…`
3. `exists(abc…)` → `absent`
4. Client re-uploads → server strips, dedupes to `def…`, returns 200
5. Client still has no record of `abc…` → **re-uploads forever, every sync**

### Resolution: store both hashes

| column | meaning | unique | indexed |
|---|---|---|---|
| `sha256` | transformed bytes; storage key + dedupe identity | yes | yes (exists) |
| `originalSha256` | bytes as received; what clients can compute | no | yes (new) |

- `/assets/exists` queries **`originalSha256`**.
- Ban list matches on **`originalSha256`** (a client/mod bans what they saw).
- Storage key and dedupe continue to use **`sha256`**.
- With no transform registered the two are equal, so this is inert by default.

Cost: one nullable-or-equal text column + one btree index. Cheap now,
retrofit-hostile later (originals are unrecoverable once transformed).

**Open question:** should `originalSha256` be a 1:N side table
(`asset_source_hashes`) instead? Several different originals (same image,
differing EXIF) can transform to one stored asset — a column only records the
first one, so subsequent variants would re-upload once each before deduping.
A side table records them all and makes sync exact. Leaning side table; decide
before implementing.

### Second interaction: the move fast-path

`ingest()` has a zero-copy path — `storage.ingestLocalFile(localPath, key)` —
that *moves* a staged file into place. A transform produces new bytes, so it
**invalidates that path**; a transformed ingest must write the new blob. The
implementation must skip the move whenever any transform mutated the source,
and keep it whenever none did.

---

## 6. Failure semantics

Different defaults per kind, deliberately:

**Guards fail closed.** A guard that throws or times out → the ingest is
rejected. A security feature that fails open is not a security feature. The
mitigation for a broken guard is operator control: per-plugin
enable/disable, so a bad guard can be switched off without a redeploy.

**Transforms fail open.** A transform that throws or times out → log loudly,
skip that transform, ingest the original bytes. Failing to strip EXIF is
cosmetic; refusing the upload is not.

**Transform output is validated before it is trusted.** `apply()` returns a
`Blob` from plugin code; the pipeline must confirm it is non-empty and sniffs as
a supported format *before* it becomes the stored bytes. On validation failure,
fall back to the last known-good transformed blob, or the original bytes if no
transform has succeeded yet — same loud-log-and-continue posture as a throw.
Without this, a transform that silently returns garbage turns a fail-open hook
into a corrupted-asset hook.

**Both are bounded by a timeout** (proposed: 5s guard, 30s transform,
configurable). Timing out must *cancel the hook's work*, not merely stop waiting
for it: hooks receive an `AbortSignal` in `IngestContext` and are contractually
required to honour it. A plugin that ignores the signal cannot be forcibly
killed (same process, no isolation), so the pipeline abandons its result,
proceeds under the failure default for its kind, and logs the offending plugin
id — an uncooperative hook leaks a task, which is a bug to surface, not to hide.

**Ordering is deterministic:** sort by the hook's numeric `order`, **defaulting
to `0`** when omitted, then by plugin id, then by the hook's index within that
plugin's registration array. The last key matters because one plugin may
register several hooks with equal `order`; without it their relative order
depends on registration timing and transform output could differ across
restarts.

**Neither kind runs on a dedupe hit** — but note *when* the dedupe hit is known.
Per §4 the guard runs before dedupe (deliberately: a banned original must be
rejected even if identical bytes are already stored, or the ban is trivially
bypassed by uploading a copy). So "does not run on a dedupe hit" applies to
**transforms only**; the guard has already run by then. What dedupe skips is the
transform, sniff, store, and insert work. §4's ordering is authoritative.

---

## 7. Rule: nothing mutates a persisted asset

Post-ingest work (thumbnails, AI enhancement, format conversion) MUST NOT
rewrite the stored original. The storage key is content-addressed
(`assets/<aa>/<bb>/<sha256>.<ext>`), so changing bytes after insert would
invalidate the key, the dedupe identity, and any ban entry simultaneously.

Derivatives belong in **plugin-namespaced storage** — which
`PluginContext.storage` already provides (keys transparently prefixed with
`plugins/<id>/`). This is exactly what `plugins/thumbnailer` does today; the
pattern generalizes to enhancement and transcoding.

"Post-enhancement" is therefore a *derivative producer*, not a mutating hook,
and needs no new primitive beyond `asset.created`.

---

## 8. SDK changes

`packages/plugin-sdk/src/index.ts`:

- Add `"ingest-guards"` and `"ingest-transforms"` to `SDK_CAPABILITIES`.
- Bump `PLUGIN_SDK_VERSION` → `0.3.0` (additive, but capability vocabulary is
  public contract).
- Extend `PluginRegistration` with optional `ingestGuards` / `ingestTransforms`.

Sketch (names provisional):

```ts
/** What a guard/transform sees. Bytes are lazy — a guard need not read them. */
export interface IngestContext {
  readonly originalSha256: string;
  readonly md5: string;
  readonly sizeBytes: number;
  readonly declaredMimeType: string | null;
  readonly uploaderId: number | null;
  readonly source: string | null;
  readonly blob: Blob;
}

export type IngestVerdict = { allow: true } | { allow: false; reason: string };

export interface IngestGuard {
  order?: number;
  check(ctx: IngestContext): Promise<IngestVerdict> | IngestVerdict;
}

export interface IngestTransform {
  order?: number;
  /** Return null to pass through unchanged (the common case). */
  apply(ctx: IngestContext): Promise<Blob | null> | Blob | null;
}
```

Core wiring: `createAssetService(repository, storage, events, hooks?)` gains an
optional hook registry, populated by the plugin loader before the first ingest.
A denied verdict surfaces as `403` carrying `reason`.

**Note:** the sniffed MIME/dimensions are not available to guards, because
sniffing happens after the store decision. A guard needing real format (vs.
client-declared) must sniff the blob itself, or we accept a second sniff pass.
Open question.

---

## 9. First consumers

| Plugin | Kind | Notes |
|---|---|---|
| `banned-hashes` | guard | own table, admin page, ban/unban routes |
| `exif-strip` | transform | drives the dual-hash design in §5 |
| `auto-tag` (AI) | `asset.created` | existing event; no new primitive |
| `thumbnailer` | `asset.created` | already shipped; unchanged |

### `banned-hashes` sketch

Own table (plugin-owned, per the SDK's tables capability):

```text
banned_hashes(sha256, md5, reason, banned_by, banned_at)
```

- Guard: reject when `originalSha256` is listed → `403`.
- Retains the hash after the binary is purged — the whole mechanism depends on
  the row outliving the file.
- Store `md5` alongside for booru-ecosystem interop (imported ban lists from
  other boorus are md5-keyed).
- Admin page + moderator-gated ban/unban routes.

---

## 10. Interaction with asset deletion and mobile sync

Assets currently have **no delete path** (no repository `delete`, no
`deletedAt`). When deletion is designed it must account for this plan:

**Delete and ban are separate actions.** Most deletes are "wrong crop,
re-uploading the good one" — auto-banning on delete makes that unfixable.
Ban is a deliberate second step (matching Danbooru's mod flow).

That gives `POST /assets/exists` four states per hash:

| state | meaning | sync client | upload |
|---|---|---|---|
| `present` | already stored | skip | 200 dedupe |
| `absent` | never seen | upload | 201 |
| `deleted` | removed, not banned | skip | allowed |
| `banned` | guard-rejected | skip | 403 |

Skipping `deleted` is what prevents the zombie-photo problem (deleted content
resurrected by the next sync).

**The four states overlap, so precedence must be explicit.** A hash can be
present *and* banned (banned after it was stored, before it was deleted), or
deleted *and* banned (the `delete + ban` action). One state is returned per
hash, resolved highest-first:

```text
banned  >  deleted  >  present  >  absent
```

- `banned` wins over everything: an upload of it is `403` even if bytes are
  still stored, and the client must never re-upload. This follows from §4 —
  the guard runs before dedupe, so a banned hash cannot be laundered through a
  dedupe hit.
- `deleted` outranks `present` so a soft-deleted row still reads as `deleted`
  while its bytes await GC.
- Uploads follow the same precedence: `banned` → `403`; otherwise `present` →
  `200` dedupe; `deleted` or `absent` → `201`.

Consequence: `banned` is the only state that changes upload *behaviour*.
`deleted` only changes *client* behaviour (don't re-upload), which is why
banning must be a deliberate action rather than implied by deletion.

**Auth and scoping:** `/assets/exists` is a batch hash oracle — it reveals
whether a specific image is in the library. Require an upload-scoped API key and
rate-limit it. Beyond that, **the visibility of `deleted` and `banned` must be
decided before the endpoint ships**: both leak moderation state. Proposed
default — `present`/`absent` answer for the whole library (dedupe is global, so
this is already observable via upload response codes), while `deleted` collapses
to `absent` unless the caller owns the asset or can moderate. `banned` is
reported to everyone, because a client that doesn't know a hash is banned will
retry it forever. Confirm before implementing (§11).

---

## 11. Open questions

1. `originalSha256` column vs. `asset_source_hashes` side table (§5).
2. Do guards get sniffed format, or sniff themselves (§8)?
3. Guard fail-closed default — acceptable, given per-plugin disable?
4. Are transform hooks operator-orderable in settings, or fixed at code order?
5. Should `banned-hashes` be seedable from an external list at boot?
6. Owner-scoping of `deleted`/`banned` in `/assets/exists` (§10) — confirm the
   proposed default before Phase 4.
7. Once (1) is settled, does `banned_hashes.sha256` mean the original or the
   stored hash? §5 says ban matches `originalSha256`, so the column is
   arguably misnamed — rename with (1), not before.

---

## 12. Phased implementation

Sized to land as coherent PRs rather than many small ones.

**Phase 1 — hook primitive (Core + SDK)**
Hook registry, pipeline reorder, guard/transform types, capabilities, timeouts,
failure semantics, loader wiring. No behaviour change with zero hooks
registered. Tests: ordering, veto, transform rewrite, timeout, fail-open vs
fail-closed, move fast-path invalidation.

**Phase 2 — `banned-hashes` plugin**
Table, guard, admin page, ban/unban routes. First real consumer; validates the
primitive.

**Phase 3 — asset deletion + `delete + ban`**
Soft delete, tombstones, the four-state model.

**Phase 4 — `findManyBySha256` + `POST /assets/exists`**
Batch existence check returning the four states. Unblocks mobile sync.

**Phase 5 — `exif-strip` plugin**
First transform. Forces the dual-hash work in §5 to be real; deliberately last
so the sync contract is settled before hashes can diverge.

Ingest clients (browser extension, PWA share target, mobile app) are tracked
separately — they depend only on Phase 4.
