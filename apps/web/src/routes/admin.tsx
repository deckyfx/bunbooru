import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";

import { useNavigate } from "@tanstack/react-router";
import { Blocks, Loader2, Power, PowerOff, SlidersHorizontal, Tags } from "lucide-react";

import { authErrorMessage, useCurrentUser } from "../lib/auth";
import { usePlugins, useExtensions, useToggleExtension, type ExtensionDto } from "../lib/plugins";
import { useUpdateUploadLimits, useUploadLimits } from "../lib/settings";
import {
  CATEGORY_ORDER,
  TAG_CATEGORY_LABEL,
  useSetTagCategory,
  type TagCategory,
} from "../lib/tags";
import { PLUGIN_ADMIN_SECTIONS } from "../plugins/registry";

/** Human-readable byte size for the caps hint. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const INPUT_CLASS =
  "block w-full rounded border border-line p-1.5 text-[12px] outline-none focus:border-link";

const CARD_CLASS = "rounded-xl border border-line bg-surface p-5 shadow-sm";

/** A built-in (non-plugin) console section. */
type CoreSection = "settings" | "taxonomy" | "extensions";
/** The selected nav target — a core section or a specific plugin's tools. */
type Section = { kind: "core"; key: CoreSection } | { kind: "plugin"; id: string };

/**
 * Superadmin console: a sidebar-navigated set of sections — runtime settings, tag
 * taxonomy, extension (plugin) management, and each active plugin's own tools.
 * Admin-only — redirects non-admins home once auth resolves (the server also
 * enforces this on every route).
 */
export function AdminPage() {
  const { data: user, isPending } = useCurrentUser();
  const navigate = useNavigate();
  const plugins = usePlugins();
  const [section, setSection] = useState<Section>({ kind: "core", key: "extensions" });

  useEffect(() => {
    if (!isPending && user?.role !== "admin") void navigate({ to: "/" });
  }, [isPending, user, navigate]);

  if (isPending || user?.role !== "admin") return null;

  // Active plugins that ship an admin UI become their own nav entries.
  const pluginTools = (plugins.data ?? []).filter((p) => PLUGIN_ADMIN_SECTIONS[p.id]);

  const isCurrent = (target: Section): boolean => {
    if (section.kind === "core" && target.kind === "core") return section.key === target.key;
    if (section.kind === "plugin" && target.kind === "plugin") return section.id === target.id;
    return false;
  };

  return (
    <div className="flex w-full gap-6">
      <aside className="w-52 shrink-0">
        <h1 className="mb-3 text-base font-bold">Admin</h1>
        <nav className="space-y-4 text-[13px]">
          <div className="space-y-0.5">
            <NavButton
              icon={Blocks}
              label="Extensions"
              active={isCurrent({ kind: "core", key: "extensions" })}
              onClick={() => setSection({ kind: "core", key: "extensions" })}
            />
            <NavButton
              icon={SlidersHorizontal}
              label="Settings"
              active={isCurrent({ kind: "core", key: "settings" })}
              onClick={() => setSection({ kind: "core", key: "settings" })}
            />
            <NavButton
              icon={Tags}
              label="Taxonomy"
              active={isCurrent({ kind: "core", key: "taxonomy" })}
              onClick={() => setSection({ kind: "core", key: "taxonomy" })}
            />
          </div>

          {pluginTools.length > 0 ? (
            <div>
              <div className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wide text-muted">
                Plugin tools
              </div>
              <div className="space-y-0.5">
                {pluginTools.map((p) => (
                  <NavButton
                    key={p.id}
                    icon={Blocks}
                    label={p.name}
                    active={isCurrent({ kind: "plugin", id: p.id })}
                    onClick={() => setSection({ kind: "plugin", id: p.id })}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        {section.kind === "core" && section.key === "extensions" ? <ExtensionsSection /> : null}
        {section.kind === "core" && section.key === "settings" ? <UploadLimitsSection /> : null}
        {section.kind === "core" && section.key === "taxonomy" ? <TagCategorySection /> : null}
        {section.kind === "plugin" ? (
          <PluginToolSection id={section.id} active={pluginTools.some((p) => p.id === section.id)} />
        ) : null}
      </div>
    </div>
  );
}

/** One left-nav entry. */
function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
        active ? "bg-link/10 font-bold text-link" : "text-ink hover:bg-line/40"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden={true} />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Render an active plugin's admin UI (or a note if it was just deactivated). */
function PluginToolSection({ id, active }: { id: string; active: boolean }) {
  const Section = PLUGIN_ADMIN_SECTIONS[id];
  if (!active || !Section) {
    return (
      <div className={CARD_CLASS}>
        <p className="text-[13px] text-muted">
          This plugin isn’t active. Enable it under <b>Extensions</b> to use its tools.
        </p>
      </div>
    );
  }
  return <Section />;
}

/**
 * Extension management: list every known plugin with metadata + on/off state and
 * toggle it at runtime. Activation takes effect immediately (routes + pages);
 * deactivation hides them but background listeners fully stop on the next restart.
 */
function ExtensionsSection() {
  const extensions = useExtensions();
  const toggle = useToggleExtension();

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-bold">Extensions</h2>
        <p className="mt-0.5 text-[12px] text-muted">
          First-party plugins. Toggling takes effect immediately — no restart to enable. Disabling
          hides a plugin’s routes and pages; any background jobs it started stop on the next restart.
        </p>
      </header>

      {extensions.isLoading ? (
        <p className="text-[13px] text-muted">Loading…</p>
      ) : extensions.isError ? (
        <p role="alert" className="text-[13px] text-tag-artist">
          Couldn’t load extensions. Please try again.
        </p>
      ) : !extensions.data || extensions.data.length === 0 ? (
        <p className="text-[13px] text-muted">No plugins are installed.</p>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {extensions.data.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              busy={toggle.isPending && toggle.variables?.id === ext.id}
              onToggle={() => toggle.mutate({ id: ext.id, active: !ext.active })}
            />
          ))}
        </ul>
      )}

      {toggle.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          {authErrorMessage(toggle.error, "Couldn’t change that plugin. Please try again.")}
        </p>
      ) : null}
    </section>
  );
}

/** One plugin's management card: metadata, capabilities, and an on/off toggle. */
function ExtensionCard({
  ext,
  busy,
  onToggle,
}: {
  ext: ExtensionDto;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={CARD_CLASS}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-bold">{ext.name}</h3>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                ext.active ? "bg-tag-character/15 text-tag-character" : "bg-line/50 text-muted"
              }`}
            >
              {ext.active ? "Active" : "Inactive"}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">
            {ext.id} · v{ext.version}
          </p>
          {ext.description ? (
            <p className="mt-1.5 text-[12px] text-ink">{ext.description}</p>
          ) : null}
          {ext.capabilities.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {ext.capabilities.map((cap) => (
                <li
                  key={cap}
                  className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted"
                >
                  {cap}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-label={`${ext.active ? "Deactivate" : "Activate"} ${ext.name}`}
          className={`flex shrink-0 items-center gap-1 rounded px-3 py-1.5 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-60 ${
            ext.active
              ? "border border-line text-ink hover:border-tag-artist hover:text-tag-artist"
              : "bg-link text-white hover:bg-link-hover"
          }`}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : ext.active ? (
            <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Power className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {ext.active ? "Deactivate" : "Activate"}
        </button>
      </div>
    </li>
  );
}

/** Edit the one-shot + resumable upload caps (bytes). */
function UploadLimitsSection() {
  const limits = useUploadLimits();
  const update = useUpdateUploadLimits();
  const [maxUpload, setMaxUpload] = useState("");
  const [maxResumable, setMaxResumable] = useState("");
  const seeded = useRef(false);

  // Seed the inputs from the server values ONCE — a later background refetch
  // (e.g. on window refocus) must not overwrite in-progress edits.
  useEffect(() => {
    if (limits.data && !seeded.current) {
      setMaxUpload(String(limits.data.maxUploadBytes));
      setMaxResumable(String(limits.data.maxResumableUploadBytes));
      seeded.current = true;
    }
  }, [limits.data]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (update.isPending) return;
    const patch: { maxUploadBytes?: number; maxResumableUploadBytes?: number } = {};
    const mu = Number(maxUpload);
    const mr = Number(maxResumable);
    if (Number.isSafeInteger(mu) && mu >= 1) patch.maxUploadBytes = mu;
    if (Number.isSafeInteger(mr) && mr >= 1) patch.maxResumableUploadBytes = mr;
    if (Object.keys(patch).length === 0) return; // nothing valid to save
    update.mutate(patch);
  }

  return (
    <section className={`${CARD_CLASS} max-w-xl`}>
      <h2 className="mb-2 text-base font-bold">Upload limits</h2>
      {limits.isLoading ? (
        <p className="text-[12px] text-muted">Loading…</p>
      ) : limits.isError ? (
        <p role="alert" className="text-[12px] text-tag-artist">
          Couldn’t load settings. Please try again.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block font-bold">One-shot upload cap (bytes)</span>
            <input
              type="number"
              min={1}
              value={maxUpload}
              onChange={(e) => setMaxUpload(e.target.value)}
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {maxUpload ? formatBytes(Number(maxUpload)) : "—"} · one-shot uploads
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block font-bold">Resumable upload cap (bytes)</span>
            <input
              type="number"
              min={1}
              value={maxResumable}
              onChange={(e) => setMaxResumable(e.target.value)}
              className={INPUT_CLASS}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {maxResumable ? formatBytes(Number(maxResumable)) : "—"} · chunked uploads
            </span>
          </label>

          {update.isError ? (
            <p role="alert" className="text-[12px] text-tag-artist">
              {authErrorMessage(update.error, "Couldn’t save. Please check the values.")}
            </p>
          ) : null}
          {update.isSuccess ? <p className="text-[12px] text-tag-character">Saved.</p> : null}

          <button
            type="submit"
            disabled={update.isPending}
            className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Save limits
          </button>
        </form>
      )}
    </section>
  );
}

/** Set a tag's category (taxonomy management). */
function TagCategorySection() {
  const setTagCategory = useSetTagCategory();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<TagCategory>("general");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (setTagCategory.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    setTagCategory.mutate({ name: trimmed, category });
  }

  return (
    <section className={`${CARD_CLASS} max-w-xl`}>
      <h2 className="mb-2 text-base font-bold">Tag category</h2>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-bold">Tag name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. hatsune_miku"
            className={INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block font-bold">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as TagCategory)}
            className={INPUT_CLASS}
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {TAG_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        {setTagCategory.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            {authErrorMessage(setTagCategory.error, "Couldn’t update the tag (does it exist?).")}
          </p>
        ) : null}
        {setTagCategory.isSuccess ? (
          <p className="text-[12px] text-tag-character">Updated.</p>
        ) : null}

        <button
          type="submit"
          disabled={setTagCategory.isPending}
          className="flex items-center justify-center gap-1 rounded bg-link px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {setTagCategory.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Set category
        </button>
      </form>
    </section>
  );
}
