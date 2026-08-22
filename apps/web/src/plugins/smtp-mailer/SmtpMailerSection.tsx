import { useEffect, useState, type FormEvent } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { unwrap } from "../../lib/api";
import { authErrorMessage } from "../../lib/auth";
import { smtpMailerApi } from "./client";

const INPUT_CLASS =
  "block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link";

const mailApi = smtpMailerApi.api.v1.plugins["smtp-mailer"];

/**
 * Admin console section for the smtp-mailer plugin: shows the transport mode
 * (SMTP vs log-only) and connection probe, edits the non-secret sender settings,
 * and sends a test email. SMTP credentials are env-only and never rendered here.
 */
export function SmtpMailerSection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["smtp-mailer", "status"],
    queryFn: async () => unwrap(await mailApi.status.get()),
  });

  // Local form state, seeded from the loaded settings.
  const [fromName, setFromName] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testTo, setTestTo] = useState("");

  useEffect(() => {
    if (!status.data) return;
    setFromName(status.data.settings.fromName ?? "");
    setFromAddress(status.data.settings.fromAddress ?? "");
    setReplyTo(status.data.settings.replyTo ?? "");
    setEnabled(status.data.settings.enabled);
  }, [status.data]);

  const saveSettings = useMutation({
    mutationFn: async () =>
      unwrap(
        await mailApi.settings.put({
          fromName: fromName.trim() || undefined,
          fromAddress: fromAddress.trim() || undefined,
          replyTo: replyTo.trim() || undefined,
          enabled,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["smtp-mailer", "status"] });
    },
  });

  const sendTest = useMutation({
    mutationFn: async (to: string) => unwrap(await mailApi.test.post({ to })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["smtp-mailer", "status"] });
    },
  });

  function onSaveSettings(e: FormEvent) {
    e.preventDefault();
    if (!saveSettings.isPending) saveSettings.mutate();
  }

  function onSendTest(e: FormEvent) {
    e.preventDefault();
    if (!sendTest.isPending && testTo.trim()) sendTest.mutate(testTo.trim());
  }

  return (
    <section>
      <h2 className="mb-2 font-bold">Email (SMTP)</h2>

      {status.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : status.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load mail status.
        </p>
      ) : status.data ? (
        <div className="mb-3 text-[12px]">
          <p className="text-muted">
            Mode: <span className="font-bold">{status.data.mode === "smtp" ? "SMTP" : "Log-only (no SMTP host configured)"}</span>
            {status.data.mode === "smtp" ? (
              status.data.verified ? (
                <span className="text-tag-character"> · connection OK</span>
              ) : (
                <span className="text-tag-artist"> · connection failed</span>
              )
            ) : null}
          </p>
          {status.data.probeError ? (
            <p role="alert" className="text-tag-artist">
              {status.data.probeError}
            </p>
          ) : null}
          <p className="text-muted">
            Outbox: {status.data.outbox.queued} queued · {status.data.outbox.sent} sent
            {status.data.outbox.failed > 0 ? ` · ${status.data.outbox.failed} failed` : ""}
          </p>
        </div>
      ) : null}

      {/* Non-secret sender settings. Credentials (host/port/user/password) are
          configured via environment variables and never shown here. */}
      <form onSubmit={onSaveSettings} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">From name</span>
          <input
            type="text"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder="Bunbooru"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">From address</span>
          <input
            type="email"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            placeholder="no-reply@example.com"
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Reply-To (optional)</span>
          <input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="support@example.com"
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Delivery enabled</span>
        </label>

        {saveSettings.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(saveSettings.error, "Couldn’t save settings.")}
          </p>
        ) : null}
        {saveSettings.isSuccess ? (
          <p className="text-[12px] text-tag-character">Settings saved.</p>
        ) : null}

        <button
          type="submit"
          disabled={saveSettings.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saveSettings.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Save settings
        </button>
      </form>

      {/* Test send — the highest-value feature: surfaces misconfiguration here. */}
      <form onSubmit={onSendTest} className="mt-4 space-y-2 border-t border-line pt-4">
        <label className="block">
          <span className="mb-1 block font-bold">Send a test email</span>
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </label>

        {sendTest.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(sendTest.error, "Test send failed.")}
          </p>
        ) : null}
        {sendTest.isSuccess ? (
          <p className="text-[12px] text-tag-character">
            {sendTest.data.mode === "smtp"
              ? "Test message accepted for delivery (queued in the outbox)."
              : "Log-only mode: the test message was written to the server log."}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={sendTest.isPending || !testTo.trim()}
          className="flex items-center justify-center gap-1 rounded border border-line px-4 py-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sendTest.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Send test
        </button>
      </form>
    </section>
  );
}
