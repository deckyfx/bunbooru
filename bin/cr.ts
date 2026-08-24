#!/usr/bin/env bun
/**
 * `cr` — CodeRabbit workflow helper for this repo.
 *
 * Wraps the recurring CodeRabbit chores so they're one command instead of a
 * hand-written `gh api … | jq … | python` each time:
 *
 *   bun bin/cr.ts review [--base <branch>]   Run the CodeRabbit CLI review → file, print findings
 *   bun bin/cr.ts review --base-commit <sha> Review only the commits since <sha> (incremental rounds)
 *   bun bin/cr.ts status <pr>                Review state (in-progress / rate-limited+slot / N findings) + CI
 *   bun bin/cr.ts slot <pr>                  Just the next available review slot (UTC + WIB)
 *   bun bin/cr.ts trigger <pr>               Post "@coderabbitai review" on a PR
 *   bun bin/cr.ts findings <pr>              List unresolved inline findings (file:line + summary)
 *
 * Lessons baked in:
 * - The CLI review can take 3+ min and dedupes per branch — always capture to a
 *   file (this writes `.cr/review.txt`); a second run returns "No findings".
 * - After a push, CodeRabbit takes ~2-3 min to decide review-vs-rate-limit;
 *   `status` reads its summary comment, which it edits in place.
 * - The rate-limit countdown can be stated in hours — parsed here accordingly.
 *
 * Portable across repos: the GitHub slug is read from the current git remote,
 * and no credentials are embedded (auth comes from the ambient `gh`/`coderabbit`
 * CLIs). Safe to copy into future projects.
 */
import { $ } from "bun";

/** IANA zone for human-friendly slot display (WIB, UTC+7). */
const TZ = "Asia/Jakarta";

/** Minimal shape of a GitHub issue comment (the PR conversation timeline). */
interface GhComment {
  user: { login: string };
  body: string;
  updated_at: string;
}

/** A GraphQL review thread: its first comment plus whether it's resolved. */
interface ReviewThread {
  isResolved: boolean;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      path: string;
      line: number | null;
      body: string;
    }>;
  };
}

/**
 * GraphQL for a PR's review threads (resolved state isn't in the REST comments
 * API). Shaped for `gh api graphql --paginate`: the `$endCursor` variable +
 * `pageInfo` let gh walk every page so big PRs aren't truncated at 100 threads.
 */
const REVIEW_THREADS_QUERY = `
query ($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { author { login } path line body } } }
      }
    }
  }
}`;

/**
 * Resolve the `owner/repo` slug for the current working directory's git remote.
 *
 * @returns The GitHub `nameWithOwner` (e.g. `deckyfx/bunbooru`).
 */
async function repoSlug(): Promise<string> {
  return (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.text()).trim();
}

/**
 * Read every page of a REST list endpoint. `--paginate --slurp` collects all
 * pages into a single array (one entry per page), which we flatten — so large
 * PRs aren't silently truncated at the first 100 items.
 *
 * @param path - REST path, e.g. `repos/owner/name/issues/1/comments`.
 */
async function ghList<T>(path: string): Promise<T[]> {
  const pages = (await $`gh api --paginate --slurp ${path}`.json()) as T[][];
  return pages.flat();
}

/**
 * Format a UTC instant as `HH:MM:SSZ = HH:MM WIB` for slot reporting.
 *
 * @param d - The instant to format.
 * @returns Both the UTC time and the localized WIB time.
 */
function fmt(d: Date): string {
  const utc = d.toISOString().slice(11, 19);
  const wib = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${utc}Z = ${wib} WIB`;
}

/**
 * Fetch CodeRabbit's summary/status comment — the single comment it edits in
 * place to announce "review in progress", findings, or a rate-limit notice.
 * Located by its auto-generated markers (robust to comment ordering), falling
 * back to the bot's first comment.
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 * @returns The summary comment, or `undefined` if CodeRabbit hasn't commented yet.
 */
async function summaryComment(repo: string, pr: string): Promise<GhComment | undefined> {
  const comments = await ghList<GhComment>(`repos/${repo}/issues/${pr}/comments`);
  const cr = comments.filter((c) => c.user.login === "coderabbitai[bot]");
  return (
    cr.find((c) =>
      /summarize by coderabbit|rate limited by coderabbit|review in progress by coderabbit/i.test(
        c.body,
      ),
    ) ?? cr[0]
  );
}

/**
 * Parse a rate-limit notice into the absolute instant the next review unlocks.
 * The countdown ("available in X hours Y minutes Z seconds") is relative to the
 * comment's last edit, so it's added to `updated_at` — never to "now".
 *
 * @param comment - CodeRabbit's summary comment.
 * @returns The next-slot instant, or `null` if the comment isn't a rate-limit notice.
 */
function parseSlot(comment: GhComment): Date | null {
  if (!/rate limit/i.test(comment.body)) return null;
  const m = comment.body.match(
    /available in\s+(?:(\d+)\s+hours?)?(?:\s*(?:and\s*)?(\d+)\s+minutes?)?(?:\s*(?:and\s*)?(\d+)\s+seconds?)?/i,
  );
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  return new Date(Date.parse(comment.updated_at) + ((h * 60 + min) * 60 + s) * 1000);
}

/**
 * Read the latest review's "Actionable comments posted: N" count.
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 * @returns The actionable-comment count, or `null` if no review reports one yet.
 */
async function actionableCount(repo: string, pr: string): Promise<number | null> {
  const reviews = await ghList<{ body: string; submitted_at: string }>(
    `repos/${repo}/pulls/${pr}/reviews`,
  );
  const latest = reviews
    .filter((r) => /Actionable comments posted/i.test(r.body))
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))
    .at(-1);
  const m = latest?.body.match(/Actionable comments posted:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Print unresolved CodeRabbit inline findings as `path:line  first-line-of-body`.
 * Uses GraphQL review threads (not the flat REST comments list) so resolved
 * threads and human comments are excluded — only open `coderabbitai` findings.
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 * @returns The number of unresolved findings printed.
 */
async function printFindings(repo: string, pr: string): Promise<number> {
  const [owner, name] = repo.split("/");
  // --paginate walks reviewThreads via $endCursor; --slurp yields one response
  // object per page, so gather nodes across all of them.
  const pages = (await $`gh api graphql --paginate --slurp -f query=${REVIEW_THREADS_QUERY} -F owner=${owner} -F name=${name} -F pr=${pr}`.json()) as Array<{
    data: { repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } } };
  }>;
  const threads = pages.flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes);
  let count = 0;
  for (const thread of threads) {
    if (thread.isResolved) continue;
    const c = thread.comments.nodes[0];
    if (!c?.author || !/coderabbitai/i.test(c.author.login)) continue;
    const where = `${c.path}:${c.line ?? "?"}`;
    const first = c.body.split("\n").find((l) => l.trim().length > 0) ?? "";
    console.log(`  ${where}  ${first.slice(0, 100)}`);
    count++;
  }
  return count;
}

/**
 * `slot <pr>` — print only the next available review slot (or that none is pending).
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 */
async function cmdSlot(repo: string, pr: string): Promise<void> {
  const c = await summaryComment(repo, pr);
  if (!c) return console.log("no CodeRabbit comment yet");
  const slot = parseSlot(c);
  if (!slot) return console.log("not rate-limited (no pending slot)");
  console.log(`next review slot: ${fmt(slot)}`);
}

/**
 * `status <pr>` — summarize a PR's CodeRabbit state (waiting / in-progress /
 * rate-limited+slot / done with N findings), list findings when present, then
 * print the CI checks.
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 */
async function cmdStatus(repo: string, pr: string): Promise<void> {
  console.log(`PR #${pr} — ${repo}`);
  const c = await summaryComment(repo, pr);
  const slot = c ? parseSlot(c) : null;
  if (!c) {
    console.log("  CodeRabbit: no comment yet (push/trigger may still be deciding — wait ~2-3 min)");
  } else if (slot) {
    console.log(`  CodeRabbit: RATE-LIMITED → next slot ${fmt(slot)}`);
  } else if (/review in progress/i.test(c.body)) {
    console.log("  CodeRabbit: review in progress (recheck in ~2-5 min)");
  } else {
    const n = await actionableCount(repo, pr);
    console.log(`  CodeRabbit: review done — Actionable comments posted: ${n ?? "?"}`);
    if (n && n > 0) await printFindings(repo, pr);
  }
  console.log("  CI:");
  await $`gh pr checks ${pr} --repo ${repo}`.nothrow();
}

/**
 * `trigger <pr>` — request a fresh CodeRabbit review by commenting the bot
 * command. The result isn't final for ~2-3 min; follow up with `status`.
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 */
async function cmdTrigger(repo: string, pr: string): Promise<void> {
  await $`gh pr comment ${pr} --repo ${repo} --body "@coderabbitai review"`;
  console.log(`triggered review on PR #${pr}; check \`cr status ${pr}\` in ~2-3 min`);
}

/**
 * `findings <pr>` — list a PR's unresolved inline findings (or note there are none).
 *
 * @param repo - `owner/repo` slug.
 * @param pr - Pull-request number.
 */
async function cmdFindings(repo: string, pr: string): Promise<void> {
  const n = await printFindings(repo, pr);
  if (n === 0) console.log("  (no inline findings)");
}

/** What a `coderabbit review` invocation actually did. */
export type ReviewOutcome = "reviewed" | "rate-limited" | "rejected-args" | "failed";

/**
 * Classify a finished review from its output and exit code.
 *
 * Exported and pure so the matching is testable against real captured output.
 * Every pattern is anchored to a WHOLE LINE: the CLI echoes finding text into the
 * same stream, so a loose `/rate limit/` search matches a review that merely
 * *discusses* rate limiting and would report "no review ran" for a run that
 * completed normally. (That nearly happened — the phrase appears in this file's
 * own review output, and only line wrapping kept it from matching.)
 *
 * @param text - Combined stdout + stderr from the CLI.
 * @param exitCode - The CLI's exit status. Findings do NOT make it non-zero.
 */
export function classifyReviewOutcome(text: string, exitCode: number): ReviewOutcome {
  // The POSITIVE marker is checked first, and that ordering is the whole design.
  // The CLI echoes finding text into the same stream it reports status on, so any
  // negative marker can be forged by a review that merely quotes it — this file's
  // own tests contain both "Rate limit exceeded" and "error: unknown option". A
  // completed review always prints this banner and a rate-limited one never does,
  // so trusting it first makes echoed text harmless by construction.
  if (/^[ \t]*Review complete[ \t]*$/m.test(text)) return "reviewed";

  // `[ \t]` rather than `\s`: `\s` matches newlines, so `^\s*` could start at one
  // line and match content on a later one — defeating the whole-line intent.
  if (/^[ \t]*(?:✗[ \t]*)?Review limit reached[ \t]*$/m.test(text)) return "rate-limited";
  if (/^[ \t]*Error: Rate limit exceeded[ \t]*$/m.test(text)) return "rate-limited";
  // Trailing text is expected here (the CLI names the offending option), so these
  // cannot be anchored at the end.
  if (/^[ \t]*error: unknown option\b/m.test(text)) return "rejected-args";
  if (/^[ \t]*Usage: coderabbit review\b/m.test(text)) return "rejected-args";

  return exitCode === 0 ? "reviewed" : "failed";
}

/**
 * `review [--base <branch>] [--base-commit <sha>]` — run the local CodeRabbit CLI
 * review of committed changes, capturing full output to `.cr/review.txt` (the CLI
 * dedupes per branch, so this run's findings are otherwise unrecoverable), and
 * print the findings summary lines.
 *
 * `--base-commit` scopes the review to the commits since `<sha>`, which is what
 * you want when iterating on review rounds: a full `--base main` re-reviews the
 * whole branch and buries the new work.
 *
 * @param base - Base branch to diff against (default `main`); ignored when
 *   `baseCommit` is given.
 * @param baseCommit - Base COMMIT on the current branch, for an incremental review.
 */
async function cmdReview(base: string, baseCommit?: string): Promise<void> {
  await $`mkdir -p .cr`;
  const out = ".cr/review.txt";
  // Flags as of CLI 0.7.x: `--committed` is a boolean, and plain text is the
  // default. The older `--type committed --plain` spelling was REMOVED — and an
  // unknown flag makes the CLI print its usage and exit 0, so a stale invocation
  // looks like it succeeded while never reviewing anything. Hence the guard below.
  const scope = baseCommit ? ["--base-commit", baseCommit] : ["--base", base];
  console.log(`running: coderabbit review ${scope.join(" ")} --committed (→ ${out})`);
  // Capture both streams directly: Bun's $ doesn't parse `> file 2>&1` redirects,
  // and .nothrow() lets us classify the outcome instead of throwing a shell error.
  // NOTE: findings do NOT make the CLI exit non-zero — a run reporting 5 findings
  // exits 0 — so a non-zero exit means the review genuinely did not happen.
  const result = await $`coderabbit review ${scope} --committed`.nothrow().quiet();
  const text = `${result.stdout.toString()}${result.stderr.toString()}`;
  await Bun.write(out, text);

  // The failure mode this wrapper exists to prevent: the CLI rejected a flag,
  // printed usage, and exited 0. Without this the caller sees "success" and an
  // empty review.
  // Classify from whole-line markers, not a loose keyword scan — see
  // classifyReviewOutcome. Rate limiting gets its own status because the
  // documented workflow branches on it ("review if you can, otherwise push").
  const outcome = classifyReviewOutcome(text, result.exitCode);
  if (outcome === "rate-limited") {
    console.error(`\ncoderabbit is rate limited — no review ran.\n\nfull output: ${out}`);
    process.exit(2);
  }
  if (outcome === "rejected-args") {
    console.error(
      `\ncoderabbit rejected the arguments — no review ran. Its flags have changed before;\n` +
        `check \`coderabbit review --help\` against the invocation above.\n\nfull output: ${out}`,
    );
    process.exit(1);
  }
  if (outcome === "failed") {
    console.error(`\ncoderabbit exited ${result.exitCode} — no review ran.\n\nfull output: ${out}`);
    process.exit(1);
  }

  const summary = text
    .split("\n")
    .filter((l) => /findings|Actionable|Major|Minor|Critical|No findings|^\s*→/i.test(l));
  console.log(summary.join("\n") || "(see .cr/review.txt)");
  console.log(`\nfull output: ${out}`);
}

/** What `review` was asked to diff against. */
export interface ReviewArgs {
  /** Base branch (default `main`); ignored when {@link baseCommit} is set. */
  base: string;
  /** Base COMMIT on the current branch, for an incremental review. */
  baseCommit?: string;
}

/**
 * Parse the `review` sub-command's arguments.
 *
 * Exported (and pure) so the flag handling is testable without shelling out. A
 * flag given WITHOUT its value throws rather than defaulting: silently falling
 * back to a full `--base main` review is the same class of quiet-wrong behaviour
 * this wrapper exists to prevent — you would get a review, just not the one you
 * asked for, and only notice by reading the diff header.
 *
 * @param argv - Argument list, e.g. `["--base-commit", "abc123"]`.
 */
export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  const known = new Set(["--base", "--base-commit"]);
  const out: ReviewArgs = { base: "main" };
  let sawBase = false;

  // Sequential scan rather than indexOf: indexOf silently ignores a MISSPELLED
  // flag, a stray positional, and any repeat of a flag — each of which would then
  // fall through to a full `--base main` review. Getting a review that isn't the
  // one you asked for is the exact failure this wrapper exists to prevent, so
  // anything unrecognised is an error, not a shrug.
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!known.has(token)) {
      throw new Error(
        token.startsWith("--")
          ? `unknown option ${token} (expected --base or --base-commit)`
          : `unexpected argument "${token}"`,
      );
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    if (token === "--base") {
      if (sawBase) throw new Error("--base given more than once");
      out.base = value;
      sawBase = true;
    } else {
      if (out.baseCommit !== undefined) throw new Error("--base-commit given more than once");
      out.baseCommit = value;
    }
    i += 1; // consume the value
  }
  return out;
}

const [cmd, arg] = Bun.argv.slice(2);

// Only dispatch when RUN as a script. Importing this module (the arg-parser
// tests do) must not execute a command as a side effect.
if (import.meta.main) {
  switch (cmd) {
    case "review": {
      // Fully local — deliberately does NOT resolve the repo slug, so it works
      // without GitHub auth or a detectable remote.
      // A usage error deserves one clear line, not a stack trace.
      let args;
      try {
        args = parseReviewArgs(Bun.argv.slice(3));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      await cmdReview(args.base, args.baseCommit);
      break;
    }
    case "status": {
      if (!arg) throw new Error("usage: cr status <pr>");
      await cmdStatus(await repoSlug(), arg);
      break;
    }
    case "slot": {
      if (!arg) throw new Error("usage: cr slot <pr>");
      await cmdSlot(await repoSlug(), arg);
      break;
    }
    case "trigger": {
      if (!arg) throw new Error("usage: cr trigger <pr>");
      await cmdTrigger(await repoSlug(), arg);
      break;
    }
    case "findings": {
      if (!arg) throw new Error("usage: cr findings <pr>");
      await cmdFindings(await repoSlug(), arg);
      break;
    }
    default:
      console.log(
        "usage: bun bin/cr.ts <review|status|slot|trigger|findings> [args]\n" +
          "  review [--base <branch>|--base-commit <sha>] | status <pr> | slot <pr> | trigger <pr> | findings <pr>",
      );
      // Non-zero so shell wrappers / CI treat an unknown command as a failure.
      process.exitCode = 1;
  }
}
