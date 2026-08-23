#!/usr/bin/env bun
/**
 * Reset a user's password (and optionally their email) — out-of-band admin
 * recovery: the last resort when someone is locked out, has no email set, or an
 * email typo blocks self-serve reset.
 *
 * Usage:
 *   bun run reset-password              # prompts for username, then password + optional email
 *   bun run reset-password <username>   # prompts for the new password + optional email
 *
 * Requires `DATABASE_URL` (Bun auto-loads `.env`). Passwords are hashed with
 * `Bun.password` (Argon2id), identical to registration. A changed email is stored
 * unverified and uniqueness is enforced case-insensitively.
 */
import * as p from "@clack/prompts";
import { MIN_PASSWORD_LENGTH } from "@bunbooru/core";
import { createDb, users } from "@bunbooru/db";
import { and, eq, ne, sql } from "drizzle-orm";

/** Minimum password length — the single shared rule from Core (reset/register/CLI). */
const MIN_PASSWORD = MIN_PASSWORD_LENGTH;

// Require an explicit DATABASE_URL — never fall back to a default. Resetting a
// password against the WRONG database (a silent localhost default) is exactly the
// kind of surprise this recovery tool must avoid; fail loudly instead. Bun
// auto-loads `.env`, so the normal case is covered.
const rawDatabaseUrl = Bun.env.DATABASE_URL?.trim();
if (!rawDatabaseUrl) {
  console.error("✖ DATABASE_URL is required (set it in .env or the environment).");
  process.exit(1);
}
// Narrow to a plain string so the value stays typed inside `main`'s closure
// (control-flow narrowing on the module const wouldn't carry into the function).
const DATABASE_URL: string = rawDatabaseUrl;

async function main(): Promise<void> {
  p.intro("bunbooru · reset password");

  const db = createDb(DATABASE_URL);

  // Username from the first CLI arg, or prompt for it.
  let username = Bun.argv[2]?.trim();
  if (!username) {
    const answer = await p.text({
      message: "Username",
      validate: (value) => (value?.trim() ? undefined : "Username is required"),
    });
    if (p.isCancel(answer)) return void p.cancel("Aborted.");
    username = answer.trim();
  }

  // Usernames are stored canonicalized (lowercase); match on that.
  const canonical = username.toLowerCase();
  const found = await db
    .select({ id: users.id, username: users.username, role: users.role, email: users.email })
    .from(users)
    .where(eq(users.username, canonical))
    .limit(1);
  const user = found[0];
  if (!user) {
    p.cancel(`No bunbooru user named "${username}".`);
    process.exit(1);
  }

  const password = await p.password({
    message: `New password for "${user.username}" (${user.role})`,
    validate: (value) =>
      (value ?? "").length >= MIN_PASSWORD ? undefined : `At least ${MIN_PASSWORD} characters`,
  });
  if (p.isCancel(password)) return void p.cancel("Aborted.");

  const confirm = await p.password({ message: "Confirm new password" });
  if (p.isCancel(confirm)) return void p.cancel("Aborted.");
  if (password !== confirm) {
    p.cancel("Passwords don't match.");
    process.exit(1);
  }

  // Optionally set a new email (blank keeps the current one). A changed address is
  // marked unverified, mirroring the app's change-email flow.
  const emailAnswer = await p.text({
    message: `New email (blank to keep ${user.email ? `"${user.email}"` : "none"})`,
    validate: (value) => {
      const v = (value ?? "").trim();
      if (!v) return undefined; // blank → keep
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : "Enter a valid email (or leave blank)";
    },
  });
  if (p.isCancel(emailAnswer)) return void p.cancel("Aborted.");
  const newEmail = emailAnswer.trim() || null;

  // Uniqueness is enforced case-insensitively (lower(email) index) — pre-check for
  // a clear message instead of a raw constraint error.
  if (newEmail) {
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, newEmail.toLowerCase()), ne(users.id, user.id)))
      .limit(1);
    if (clash[0]) {
      p.cancel(`Email "${newEmail}" is already in use by another account.`);
      process.exit(1);
    }
  }

  const spinner = p.spinner();
  spinner.start("Hashing and updating…");
  const passwordHash = await Bun.password.hash(password);
  const changes: { passwordHash: string; email?: string; emailVerifiedAt?: Date | null } = {
    passwordHash,
  };
  if (newEmail) {
    changes.email = newEmail;
    changes.emailVerifiedAt = null; // new address is unproven
  }
  await db.update(users).set(changes).where(eq(users.id, user.id));
  spinner.stop(newEmail ? "Password and email updated." : "Password updated.");

  p.outro(
    newEmail
      ? `Done — "${user.username}" can sign in with the new password; email set to ${newEmail} (unverified).`
      : `Done — "${user.username}" can now sign in with the new password.`,
  );
}

main()
  .then(() => process.exit(0)) // Bun's SQL pool keeps the process alive; exit explicitly.
  .catch((error) => {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
