import { useState, type FormEvent } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { exampleApi } from "./client";

const INPUT_CLASS =
  "block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link";

/**
 * Admin console section contributed by the example plugin. Exercises the plugin
 * HTTP surface end to end through a typed Eden client: reads the live post count
 * (`/ping`, Core-service access) and the recent pings (`/pings`, a plugin-owned
 * table), and records a ping (`POST /pings`, auth-gated server-side).
 */
export function ExampleSection() {
  const queryClient = useQueryClient();
  const ping = useQuery({
    queryKey: ["example", "ping"],
    queryFn: async () => unwrap(await exampleApi.api.v1.plugins.example.ping.get()),
  });
  const pings = useQuery({
    queryKey: ["example", "pings"],
    queryFn: async () => unwrap(await exampleApi.api.v1.plugins.example.pings.get()),
  });
  const [note, setNote] = useState("");
  const record = useMutation({
    mutationFn: async (value: string) =>
      unwrap(await exampleApi.api.v1.plugins.example.pings.post({ note: value })),
    onSuccess: () => {
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["example", "pings"] });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (record.isPending) return;
    const trimmed = note.trim();
    if (!trimmed) return;
    record.mutate(trimmed);
  }

  return (
    <section>
      <h2 className="mb-2 font-bold">Example plugin</h2>
      <p className="mb-3 text-[11px] text-muted">
        Demonstrates the plugin system: a plugin route reading Core data (
        {ping.data ? `${ping.data.posts} posts` : "…"}) and its own table.
      </p>

      <form onSubmit={onSubmit} className="mb-3 space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">Record a ping</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="a short note"
            maxLength={200}
            className={INPUT_CLASS}
          />
        </label>
        {record.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(record.error, "Couldn’t record the ping (are you signed in?).")}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={record.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {record.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Record ping
        </button>
      </form>

      {pings.isLoading ? (
        <p className="text-[12px] text-muted">Loading pings…</p>
      ) : pings.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load pings.
        </p>
      ) : pings.data && pings.data.length > 0 ? (
        <ul className="space-y-1 text-[12px]">
          {pings.data.map((p) => (
            <li key={p.id} className="flex justify-between gap-2 border-b border-line pb-1">
              <span className="truncate">{p.note}</span>
              <span className="shrink-0 text-muted">{new Date(p.createdAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">No pings yet.</p>
      )}
    </section>
  );
}
