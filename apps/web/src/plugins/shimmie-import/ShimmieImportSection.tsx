import { useEffect, useRef, useState, type FormEvent } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { shimmieImportApi } from "./client";

const INPUT_CLASS =
  "block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link";

/** Unwrap an Eden response: throw on transport error (e.g. 401), else return the
 *  body. Unlike the shared `unwrap`, it keeps the `{ ok, error }` result envelope
 *  (which is the importer's domain result, not the API error envelope). */
async function call<T>(res: { data: T | null; error: unknown }): Promise<T> {
  if (res.error) throw res.error;
  if (res.data == null) throw new Error("Unexpected API response");
  return res.data;
}

interface Progress {
  imported: number;
  failed: number;
  skipped: number;
  cursor: number;
  maxId: number;
  done: boolean;
}

const importApi = shimmieImportApi.api.v1.plugins["shimmie-import"];

/**
 * Admin console section: import posts from a running shimmie via its GraphQL +
 * User-API extensions. Preflight validates the URL/key; import creates a run and
 * loops bounded batches (`step`) until done, showing live progress. The api_key is
 * held only in this form's state and sent per request — never persisted.
 */
export function ShimmieImportSection() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:5013");
  const [apiKey, setApiKey] = useState("");
  const [allUsers, setAllUsers] = useState(true);
  const [usersList, setUsersList] = useState("");
  const [targetUsername, setTargetUsername] = useState("");
  const [sourceTimezone, setSourceTimezone] = useState("UTC");

  const [busy, setBusy] = useState<"idle" | "preflight" | "importing" | "retrying">("idle");
  const [preflight, setPreflight] = useState<{ actingUser: string; maxId: number } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: ["shimmie-import", "runs"],
    queryFn: async () => call(await importApi.runs.get()),
  });
  const refreshRuns = () => queryClient.invalidateQueries({ queryKey: ["shimmie-import", "runs"] });

  // Stop the import loop if the component unmounts (leaving /admin), so it doesn't
  // keep hitting the API or setting state on an unmounted component.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  function resetMessages() {
    setError(null);
    setNotice(null);
  }

  async function onPreflight(e: FormEvent) {
    e.preventDefault();
    if (busy !== "idle") return;
    resetMessages();
    setPreflight(null);
    setBusy("preflight");
    try {
      const res = await call(await importApi.preflight.post({ baseUrl, apiKey }));
      if (!res.ok) setError(res.error);
      else {
        setPreflight({ actingUser: res.actingUser, maxId: res.maxId });
        setNotice(`Connected as ${res.actingUser} · ${res.maxId} posts to scan.`);
      }
    } catch {
      setError("Preflight request failed (are you signed in as an admin?).");
    } finally {
      setBusy("idle");
    }
  }

  async function onImport() {
    if (busy !== "idle") return;
    resetMessages();
    setProgress(null);
    setBusy("importing");
    cancelRef.current = false;
    try {
      const users = allUsers ? "*" : usersList.split(",").map((n) => n.trim()).filter(Boolean);
      if (!allUsers && (users as string[]).length === 0) {
        setError("List at least one shimmie username, or choose “all users”.");
        return;
      }
      const started = await call(
        await importApi.runs.post({
          baseUrl,
          apiKey,
          users,
          targetUsername: targetUsername.trim() || undefined,
          sourceTimezone: sourceTimezone.trim() || "UTC",
        }),
      );
      if (!started.ok) {
        setError(started.error);
        return;
      }
      const activeRunId = started.runId;
      setRunId(activeRunId);
      for (;;) {
        if (cancelRef.current) {
          await importApi.runs({ id: activeRunId }).cancel.post();
          setNotice("Import canceled.");
          break;
        }
        const step = await call(await importApi.runs({ id: activeRunId }).step.post({ apiKey }));
        // Bail after the await if we were unmounted / canceled mid-request.
        if (cancelRef.current) break;
        if (!step.ok) {
          setError(step.error);
          break;
        }
        setProgress({
          imported: step.totals.imported,
          failed: step.totals.failed,
          skipped: step.totals.skipped,
          cursor: step.cursor,
          maxId: step.maxId,
          done: step.done,
        });
        if (step.done) {
          setNotice("Import complete.");
          break;
        }
      }
    } catch {
      setError("Import request failed (are you signed in as an admin?).");
    } finally {
      setBusy("idle");
      void refreshRuns();
    }
  }

  async function onRetry(targetRunId: number) {
    if (busy !== "idle") return;
    if (!apiKey) {
      setError("Enter the shimmie API key to retry.");
      return;
    }
    resetMessages();
    setBusy("retrying");
    cancelRef.current = false;
    try {
      for (;;) {
        if (cancelRef.current) break;
        const res = await call(await importApi.runs({ id: targetRunId })["retry-failed"].post({ apiKey }));
        if (cancelRef.current) break;
        if (!res.ok) {
          setError(res.error);
          break;
        }
        setProgress((prev) =>
          prev ? { ...prev, imported: prev.imported + res.recovered, failed: res.remainingFailed } : prev,
        );
        // Stop when nothing's left OR this batch made no progress — otherwise a
        // set of permanently-failing posts (re-selected each call) would loop forever.
        if (res.remainingFailed === 0 || res.recovered === 0) {
          setNotice(
            res.remainingFailed === 0
              ? "Retry complete — all recovered."
              : `Retry stopped · ${res.remainingFailed} still failing.`,
          );
          break;
        }
      }
    } catch {
      setError("Retry request failed (are you signed in as an admin?).");
    } finally {
      setBusy("idle");
      void refreshRuns();
    }
  }

  const pct = progress && progress.maxId > 0 ? Math.round((progress.cursor / progress.maxId) * 100) : 0;

  return (
    <section>
      <h2 className="mb-2 font-bold">Import from Shimmie</h2>
      <p className="mb-3 text-[11px] text-muted">
        Pulls posts from a running shimmie via its GraphQL + User&nbsp;API extensions. The API key
        is sent per request and never stored.
      </p>

      <form onSubmit={onPreflight} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">Shimmie base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setPreflight(null); // a new host needs a fresh preflight before import
            }}
            placeholder="http://localhost:5013"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setPreflight(null); // key change invalidates the prior preflight
            }}
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="mb-1 font-bold">Import from</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="shimmie-import-scope"
              checked={allUsers}
              onChange={() => setAllUsers(true)}
            />
            <span>All users</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="shimmie-import-scope"
              checked={!allUsers}
              onChange={() => setAllUsers(false)}
            />
            <span>Specific usernames</span>
          </label>
          {!allUsers ? (
            <input
              type="text"
              value={usersList}
              onChange={(e) => setUsersList(e.target.value)}
              placeholder="comma-separated shimmie usernames"
              className={INPUT_CLASS}
            />
          ) : null}
        </fieldset>

        <label className="block">
          <span className="mb-1 block font-bold">Attribute to bunbooru user</span>
          <input
            type="text"
            value={targetUsername}
            onChange={(e) => setTargetUsername(e.target.value)}
            placeholder="username (blank = you)"
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Source timezone</span>
          <input
            type="text"
            value={sourceTimezone}
            onChange={(e) => setSourceTimezone(e.target.value)}
            placeholder="UTC"
            className={INPUT_CLASS}
          />
          <span className="mt-1 block text-[11px] text-muted">
            IANA name of the shimmie server’s timezone (its “posted” dates). UTC for the standard
            Docker image.
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {error}
          </p>
        ) : null}
        {notice ? <p className="text-[12px] text-tag-character">{notice}</p> : null}

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy !== "idle" || !apiKey}
            className="flex items-center justify-center gap-1 rounded border border-line px-4 py-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "preflight" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Preflight
          </button>
          <button
            type="button"
            onClick={() => void onImport()}
            disabled={busy !== "idle" || !apiKey || !preflight}
            className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === "importing" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Import
          </button>
          {busy === "importing" || busy === "retrying" ? (
            <button
              type="button"
              onClick={() => (cancelRef.current = true)}
              className="rounded border border-line px-4 py-2"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      {progress ? (
        <div className="mt-3 space-y-1 text-[12px]">
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Import progress"
            className="h-2 w-full overflow-hidden rounded bg-line/40"
          >
            <div className="h-full bg-link" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-muted" aria-live="polite">
            {progress.cursor} / {progress.maxId} scanned · {progress.imported} imported ·{" "}
            {progress.skipped} skipped
            {progress.failed > 0 ? ` · ${progress.failed} failed` : ""}
            {progress.done ? " · done" : ""}
          </p>
          {progress.failed > 0 && runId !== null ? (
            <button
              type="button"
              onClick={() => void onRetry(runId)}
              disabled={busy !== "idle" || !apiKey}
              className="mt-1 flex items-center gap-1 rounded border border-line px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === "retrying" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              Retry {progress.failed} failed
            </button>
          ) : null}
        </div>
      ) : null}

      {runsQuery.data && runsQuery.data.length > 0 ? (
        <div className="mt-4">
          <h3 className="mb-1 font-bold">Recent runs</h3>
          <ul className="space-y-1 text-[11px]">
            {runsQuery.data.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-2 border-b border-line pb-1">
                <span className="truncate">
                  #{run.id} · {run.sourceInstance} · {run.userFilter === "*" ? "all users" : run.userFilter}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-muted">
                  <span>
                    {run.status} · {run.imported}✓
                    {run.failed > 0 ? ` · ${run.failed}✗` : ""} · {run.cursor}/{run.maxId}
                  </span>
                  {run.failed > 0 ? (
                    <button
                      type="button"
                      onClick={() => void onRetry(run.id)}
                      disabled={busy !== "idle" || !apiKey}
                      title={apiKey ? "Retry this run's failed posts" : "Enter the API key above to retry"}
                      className="rounded border border-line px-2 py-0.5 text-link disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Retry
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
