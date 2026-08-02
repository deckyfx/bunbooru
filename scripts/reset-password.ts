#!/usr/bin/env bun
/**
 * Reset a user's password — admin recovery, since bunbooru has no self-serve
 * password reset yet.
 *
 * Usage:
 *   bun run reset-password              # prompts for username + password
 *   bun run reset-password <username>   # prompts for the new password only
 *
 * Reads `DATABASE_URL` from the environment (Bun auto-loads `.env`); falls back
 * to the local compose default. Passwords are hashed with `Bun.password` (Argon2id),
 * identical to registration, so the account logs in normally afterward.
 */
import * as p from "@clack/prompts";
import { createDb, users } from "@bunbooru/db";
import { eq } from "drizzle-orm";

/** Minimum password length — mirrors the registration rule. */
const MIN_PASSWORD = 8;

const DATABASE_URL =
  Bun.env.DATABASE_URL?.trim() || "postgres://bunbooru:bunbooru@localhost:5432/bunbooru";

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
    .select({ id: users.id, username: users.username, role: users.role })
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

  const spinner = p.spinner();
  spinner.start("Hashing and updating…");
  const passwordHash = await Bun.password.hash(password);
  await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
  spinner.stop("Password updated.");

  p.outro(`Done — "${user.username}" can now sign in with the new password.`);
}

main()
  .then(() => process.exit(0)) // Bun's SQL pool keeps the process alive; exit explicitly.
  .catch((error) => {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
