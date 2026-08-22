import { useEffect, useRef, useState, type FormEvent } from "react";

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
 * (SMTP vs log-only) + connection probe, edits the full SMTP connection and
 * sender settings, and sends a test email. The SMTP password is WRITE-ONLY — it
 * is never sent back to the browser; leave the field blank to keep the stored one.
 */
export function SmtpMailerSection() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["smtp-mailer", "status"],
    queryFn: async () => unwrap(await mailApi.status.get()),
  });

  // Local form state, seeded from the loaded settings (password is never seeded).
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [testTo, setTestTo] = useState("");

  const hasStoredPassword = status.data?.settings.hasPassword ?? false;

  // Seed the form from the loaded settings ONCE, not on every status refetch —
  // otherwise a test-send (which invalidates the status query) would refetch and
  // clobber the admin's unsaved edits. An explicit save re-arms the seed so the
  // persisted values re-apply. The password is intentionally NOT seeded (write-only).
  const seeded = useRef(false);
  useEffect(() => {
    if (!status.data || seeded.current) return;
    seeded.current = true;
    const s = status.data.settings;
    setHost(s.host ?? "");
    setPort(s.port !== null ? String(s.port) : "");
    setSecure(s.secure);
    setUsername(s.username ?? "");
    setFromName(s.fromName ?? "");
    setFromAddress(s.fromAddress ?? "");
    setReplyTo(s.replyTo ?? "");
    setEnabled(s.enabled);
  }, [status.data]);

  const saveSettings = useMutation({
    mutationFn: async () => {
      const trimmedPort = port.trim();
      return unwrap(
        // Emptied text fields are sent as `null` (an intentional CLEAR). The
        // password is only sent when the admin actually typed one — omitting it
        // keeps the stored secret (write-only), so we never round-trip it.
        await mailApi.settings.put({
          host: host.trim() || null,
          port: trimmedPort ? Number(trimmedPort) : null,
          secure,
          username: username.trim() || null,
          ...(password ? { password } : {}),
          fromName: fromName.trim() || null,
          fromAddress: fromAddress.trim() || null,
          replyTo: replyTo.trim() || null,
          enabled,
        }),
      );
    },
    onSuccess: () => {
      seeded.current = false; // re-seed from the saved values on refetch
      setPassword(""); // clear the typed secret from the form after saving
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
            Mode:{" "}
            <span className="font-bold">
              {status.data.mode === "smtp" ? "SMTP" : "Log-only (no SMTP host configured)"}
            </span>
            {status.data.mode === "smtp" ? (
              status.data.verified ? (
                <span className="text-tag-character"> · connection OK</span>
              ) : (
                <span className="text-tag-artist"> · connection failed</span>
              )
            ) : null}
          </p>
          {status.data.mode !== "smtp" ? (
            <p className="text-muted">Set an SMTP host below to send real email.</p>
          ) : null}
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

      <form onSubmit={onSaveSettings} className="space-y-3">
        {/* SMTP connection — configured here (no environment variables). */}
        <fieldset className="space-y-3 rounded border border-line p-3">
          <legend className="px-1 text-[12px] font-bold">SMTP connection</legend>

          <label className="block">
            <span className="mb-1 block font-bold">Host</span>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="smtp.example.com"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>

          <div className="flex items-end gap-3">
            <label className="block flex-1">
              <span className="mb-1 block font-bold">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="587"
                className={INPUT_CLASS}
              />
            </label>
            <label className="flex items-center gap-2 pb-2">
              <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
              <span>Implicit TLS (port 465)</span>
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block font-bold">Username (optional)</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="apikey"
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </label>

          <label className="block">
            <span className="mb-1 block font-bold">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={hasStoredPassword ? "•••••••• (leave blank to keep)" : "SMTP password"}
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {hasStoredPassword
                ? "A password is stored. Type a new one to replace it; leave blank to keep it."
                : "Stored securely on the server and never shown again."}
            </span>
          </label>
        </fieldset>

        {/* Sender identity. */}
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
