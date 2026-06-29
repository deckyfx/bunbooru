#!/usr/bin/env bun
/**
 * `cr` — CodeRabbit workflow helper for this repo.
 *
 * Wraps the recurring CodeRabbit chores so they're one command instead of a
 * hand-written `gh api … | jq … | python` each time:
 *
 *   bun bin/cr.ts review [--base <branch>]   Run the CodeRabbit CLI review → file, print findings
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

/**
 * `review [--base <branch>]` — run the local CodeRabbit CLI review of committed
 * changes against `base`, capturing full output to `.cr/review.txt` (the CLI
 * dedupes per branch, so this run's findings are otherwise unrecoverable), and
 * print the findings summary lines.
 *
 * @param base - Base branch to diff against (default `main`).
 */
async function cmdReview(base: string): Promise<void> {
  await $`mkdir -p .cr`;
  const out = ".cr/review.txt";
  console.log(`running: coderabbit review --base ${base} --type committed (→ ${out})`);
  // Capture both streams directly: Bun's $ doesn't parse `> file 2>&1` redirects,
  // and .nothrow() keeps a non-zero exit (findings present) from throwing.
  const result = await $`coderabbit review --base ${base} --type committed --plain`
    .nothrow()
    .quiet();
  const text = `${result.stdout.toString()}${result.stderr.toString()}`;
  await Bun.write(out, text);
  const summary = text
    .split("\n")
    .filter((l) => /findings|Actionable|Major|Minor|Critical|No findings|^\s*→/i.test(l));
  console.log(summary.join("\n") || "(see .cr/review.txt)");
  console.log(`\nfull output: ${out}`);
}

const [cmd, arg] = Bun.argv.slice(2);

switch (cmd) {
  case "review": {
    // Fully local — deliberately does NOT resolve the repo slug, so it works
    // without GitHub auth or a detectable remote.
    const baseIdx = Bun.argv.indexOf("--base");
    await cmdReview(baseIdx !== -1 ? (Bun.argv[baseIdx + 1] ?? "main") : "main");
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
        "  review [--base <branch>] | status <pr> | slot <pr> | trigger <pr> | findings <pr>",
    );
    // Non-zero so shell wrappers / CI treat an unknown command as a failure.
    process.exitCode = 1;
}
