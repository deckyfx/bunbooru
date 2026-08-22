# Mail Delivery + Password Reset — Design Plan

**Status:** draft, not implemented. Revisit before building.

Two coupled pieces: a **`MailProvider` contract in Core with an `smtp-mailer`
plugin implementing it**, and **self-serve password reset** built on top. Reset
is the first consumer; the transport is deliberately designed to outlive it
(email verification, notifications, digests).

Related: [ingest-hooks.md](./ingest-hooks.md) also proposes an SDK version bump —
see §8 on coordinating them.

---

## 1. The dependency problem

CLAUDE.md's Core Rule gives Core **Authentication**. Password reset is
authentication: it rewrites `passwordHash` and revokes sessions, both Core-owned.

But CLAUDE.md's Dependency Rule forbids `core → plugins`. So Core cannot call an
SMTP plugin, and the Plugin Rule says an optional feature like SMTP must be a
plugin. These pull in opposite directions.

**Resolution: dependency inversion, exactly as `StorageProvider` already does
it.** Core defines the contract and depends only on it; a plugin supplies the
implementation. The existing `StorageProvider` doc comment states the goal
outright — *"new providers require zero Core changes"* — and Filesystem/S3/R2
all satisfy one interface. Mail is the same shape:

```text
Core  →  MailProvider (interface)  ←  plugins/smtp-mailer
                                   ←  future: ses-mailer, postmark-mailer
```

So:

- **The reset *flow* lives in Core** — it is authentication, and it mutates
  Core-owned state.
- **The mail *transport* is a plugin** — SMTP, credentials, retries, templates.

This is not a special case carved out for mail; it is the third instance of a
pattern the SDK already names (`storage-providers`, `search-providers`).

### When no provider is registered

Core must degrade, never 500:

- `POST /auth/forgot-password` → `503` with a clear "password reset is not
  configured" body, and the web UI hides the "forgot password?" link.
- The admin console shows mail as unconfigured.
- `bun run reset-password` (the existing CLI, which currently documents itself
  as the recovery path *"since bunbooru has no self-serve password reset yet"*)
  remains the fallback and is **not** removed. It is also the only recovery for
  accounts with no email (§3).

---

## 2. `MailProvider` contract (Core)

Deliberately minimal — the smallest surface every backend can satisfy. Anything
SMTP-specific (pooling, TLS mode, DKIM) stays inside the plugin.

```ts
/** A message Core asks the active provider to deliver. */
export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain-text body. REQUIRED — never send HTML-only mail. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  /**
   * Stable idempotency key (e.g. `password-reset:<tokenId>`). Providers and the
   * outbox use it to make a retried send at-most-once in practice.
   */
  idempotencyKey: string;
}

export interface MailProvider {
  /**
   * Accept a message for delivery. Resolving means *accepted*, not *delivered* —
   * providers queue. Throwing means permanently rejected (bad address, refused).
   */
  send(mail: OutgoingMail): Promise<void>;
  /** Cheap liveness probe for the admin console (verify SMTP connection). */
  verify(): Promise<void>;
}
```

Notes:

- **No `from`.** The provider owns the envelope sender; Core must not be able to
  spoof it. The plugin's admin page configures it.
- **No attachments, no CC/BCC, no templating.** Add when a real consumer needs
  them, not speculatively (YAGNI).
- **`text` is required.** HTML-only mail is a spam-filter magnet and unreadable
  in text clients.

---

## 3. Blocking constraint: email is optional and unverified

From `packages/db/src/schema.ts`:

```text
email: text("email").unique(),          -- NULLABLE
```

The column comment is explicit: *"registration needs only username + password."*
There is no `emailVerifiedAt`. Two consequences, and the second is the main
open decision in this plan.

**Accounts without an email cannot self-reset.** Expected and fine — the CLI
covers them. But the UI must say so honestly rather than silently doing nothing,
and the account settings page should prompt users to add an email *before* they
need it. Worth shipping that prompt ahead of reset itself.

**Unverified email is an account-takeover vector.** If Alice registers and typos
`bob@example.com`, then Bob — who never touched this server — can request a
reset for Alice's account and receive a working token. Today that is harmless,
because the address is never used for anything. Adding reset makes an unverified
address a credential.

Three options:

| Option | Behaviour | Cost |
|---|---|---|
| **A. Verify first** | Add `emailVerifiedAt`; only verified addresses can reset | One more flow, but it *reuses every primitive here* (§5) |
| **B. Verify-on-first-use** | First reset email doubles as verification | Subtle; the takeover window is exactly the risk we're closing |
| **C. Accept it** | Any stored address can reset | Free; defensible only for single-user/trusted instances |

**Recommendation: A.** Email verification and password reset are the same
machinery — a purposed token, a mail send, a confirm endpoint. Building the
token table generically (§5) makes verification a small increment rather than a
second project, and it is the difference between reset being safe and being a
takeover path on a multi-user instance.

Whichever is chosen, decide **before** implementing: it determines whether
`auth_tokens` needs a `verify-email` purpose from day one.

---

## 4. Second blocking constraint: no public base URL

Reset emails contain an absolute link. `apps/api/src/env-config.ts` has no
public URL setting.

**Do not derive it from the request's `Host` header.** Host-header injection is
the classic password-reset vulnerability: an attacker sends `Host: evil.test`,
the victim receives a genuine reset mail pointing at the attacker's domain, and
clicking it hands over the token. The link's origin must come from server
configuration, never from the request.

Add `PUBLIC_BASE_URL` to env-config: required (no default) whenever a mail
provider is registered, validated as an absolute `http(s)` URL at boot so a
misconfiguration fails fast rather than at the first reset.

---

## 5. Password reset flow (Core)

### Token storage

Follow the existing precedent exactly — `auth-service.ts` already has
`sha256hex()` and stores sessions and API keys as digests, never raw.

```text
auth_tokens(
  id, user_id, purpose, token_hash, expires_at,
  consumed_at, created_at, requested_ip
)
  unique(token_hash)
  index(user_id, purpose)
```

`purpose` is an enum — `password-reset` now, `verify-email` and `change-email`
later. Generic from the start so §3 option A is additive.

- Raw token: 32 bytes from `crypto.getRandomValues`, base64url. Never logged,
  never stored.
- **Single-use** — `consumed_at` set inside the same transaction that rewrites
  the password hash.
- **TTL 30 minutes.** Short enough to limit exposure, long enough to survive
  mail delays.
- **Requesting a new token invalidates outstanding ones** for that user+purpose.
- Reaper job for expired rows, alongside the existing session GC.

### Endpoints

`POST /auth/forgot-password` — body `{ email }`

- **Always returns `200` with identical body and timing**, whether or not the
  address exists. Anything else turns the endpoint into an account-enumeration
  oracle. Note `email` is `unique`, so a naive implementation leaks membership
  precisely.
- Rate-limit per address **and** per IP. Depends on the rate-limiter already
  planned in roadmap PR B.
- Never reveals whether the address is unverified or the account has no email.

`POST /auth/reset-password` — body `{ token, password }`

- Validates hash, expiry, `consumed_at IS NULL`.
- Enforces the same minimum length as registration (the CLI uses 8 — keep one
  shared constant rather than a third copy).
- In one transaction: rewrite `passwordHash`, set `consumed_at`, **revoke all of
  that user's sessions**. A reset is the remedy for a compromised account, so
  leaving existing sessions alive defeats it.
- **API keys are left alone by default** — revoking them silently breaks the
  user's sync clients (see [ingest-clients.md](./ingest-clients.md)). Offer it as
  an explicit checkbox on the reset page instead. Open question 4.

`AuthService` gains `requestPasswordReset(email)` and
`resetPassword(token, password)`. It currently has no password-change method at
all, so a plain `changePassword(userId, current, next)` for logged-in users
belongs in the same change — same validation, same session-revocation choice.

### The reset page and referrer leakage

The token arrives as a URL query parameter, which leaks via `Referer` to any
third-party resource the page loads.

- Serve the reset route with `Referrer-Policy: no-referrer`.
- The page loads **no external resources** (the CSP is already strict).
- After reading the token, `history.replaceState` strips it from the URL so it
  does not linger in history or get pasted into a bug report.

---

## 6. `smtp-mailer` plugin

### Transport

Bun has no native SMTP client, so this is a justified dependency: **nodemailer**
(mature, runs on Bun, handles STARTTLS/auth/pooling). Noting the deviation from
the Bun-native preference explicitly, since the alternative is hand-rolling SMTP
with TLS — strictly worse.

### Configuration split

Credentials in **env**, presentation in **admin settings**:

| Setting | Where | Why |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | env | Secrets. Never admin-editable, never rendered back to a browser. |
| From name/address, reply-to, enabled | admin settings | Operational, non-secret, benefits from a UI. |

The admin page shows connection status via `verify()` and a **"send test email"**
button — the single highest-value feature here, because SMTP misconfiguration is
otherwise discovered only when a user's reset silently fails.

### Outbox, not inline sending

Sending inside the request handler makes password reset as slow and as
failure-prone as the SMTP server. The plugin owns an outbox table
(`mail_outbox`: idempotency key unique, payload, attempts, next_attempt_at,
last_error, sent_at) and a background worker draining it with exponential
backoff and a bounded retry budget.

`MailProvider.send()` therefore **enqueues and returns** — which is exactly why
§2 defines resolution as *accepted*, not *delivered*.

Failed-permanently rows stay visible in the admin page rather than vanishing.
Bounce handling is out of scope.

### Development

A `log-only` provider that renders the message to the log instead of sending —
selected automatically when `NODE_ENV !== "production"` and no SMTP host is set,
so reset is testable with zero configuration. Optionally add MailHog to
`docker-compose.yml` behind a profile, mirroring the existing `redis` profile.

### Logging discipline

Never log the reset token, the reset URL, or full message bodies. Log recipient
(optionally masked), subject, idempotency key, attempt count, and provider error.

---

## 7. Templates

Two, both plain-text-first:

- **Password reset** — link, expiry, and "if you didn't request this, ignore it;
  your password is unchanged."
- **Email verification** (with §3 option A).

Rendered in the plugin, not Core: Core passes structured data, the plugin owns
wording and layout. Keep them as plain TS template functions — no template
engine until a third consumer justifies one.

---

## 8. SDK changes

`packages/plugin-sdk/src/index.ts`:

- Add `"mail-providers"` to `SDK_CAPABILITIES`.
- Add `mailProvider?: MailProvider` to `PluginRegistration`.
- Re-export `MailProvider` (as `StorageProvider` already is).
- Bump `PLUGIN_SDK_VERSION`.

**Coordinate the version bump with [ingest-hooks.md](./ingest-hooks.md) §8**,
which also proposes `0.3.0`. Whichever lands first takes `0.3.0`; the second
takes `0.4.0`. Do not let both claim the same version.

**Registration conflict:** if two enabled plugins both register a mail provider,
**fail fast at boot** naming both plugin ids. Last-wins would mean mail silently
leaving via an unintended transport, which is exactly the kind of thing nobody
notices until it matters. Same rule should eventually apply to storage/search
providers.

---

## 9. Open questions

1. **§3 — verify email first (A), verify-on-first-use (B), or accept (C)?**
   Blocks the `auth_tokens` purpose enum. Recommend A.
2. Should registration require an email? (Currently optional; making it required
   changes onboarding and is a separate decision from verification.)
3. Reset TTL — 30 min, or 60 for slow mail servers?
4. Should reset revoke API keys? Default no; explicit checkbox. Confirm.
5. Does the outbox belong to the plugin, or is it generic enough for Core to own
   so every future provider inherits retries? (Leaning plugin — Core should not
   grow a queue for one consumer.)
6. Rate-limit thresholds for `forgot-password`, and its dependency on PR B.

---

## 10. Phased implementation

**Phase 1 — `MailProvider` contract + SDK wiring**
Interface in Core, `mail-providers` capability, registration + conflict
detection, log-only dev provider, `PUBLIC_BASE_URL` in env-config with boot
validation. No user-visible feature yet; testable end-to-end via the log
provider.

**Phase 2 — `smtp-mailer` plugin**
nodemailer transport, env config, outbox + retry worker, admin page with status
and test-send.

**Phase 3 — `auth_tokens` + email verification** *(if §3 option A)*
Generic purposed-token table, reaper, verification flow, `emailVerifiedAt`, and
the account-settings prompt to add an email.

**Phase 4 — password reset**
`requestPasswordReset` / `resetPassword` / `changePassword` on `AuthService`,
both endpoints, the reset page with referrer hardening, session revocation,
rate-limiting, and the web UI's "forgot password?" link gated on a provider
being registered.

Phases 1–2 are independently useful — any later notification feature reuses them
unchanged. Phase 4 is the only one that touches authentication, and it should
not start until §3 is decided.
