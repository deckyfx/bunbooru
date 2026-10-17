import { useEffect, useMemo, useState } from "react";

import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";

import { tokenize } from "@bunbooru/plugin-wiki/markup";
import { displayTitle, parseTitle } from "@bunbooru/plugin-wiki/title";

import { useCurrentUser } from "../../lib/auth";
import { fetchPage, pageKey, type WikiPageDto } from "./client";
import { DeletePage } from "./DeletePage";
import { WikiBody } from "./WikiBody";
import { WikiEditor } from "./WikiEditor";
import { WikiHistory } from "./WikiHistory";

type Tab = "view" | "edit" | "history";

/**
 * `/wiki/:title`: one page, with View, Edit (signed-in users) and History
 * tabs. A non-canonical title in the URL (`Blue Sky`) is replaced by the
 * normalized one (`blue_sky`), which is what the page is stored under.
 */
export function WikiPage() {
  const { title: raw } = useParams({ from: "/wiki/$title" });
  const navigate = useNavigate();
  const parsed = parseTitle(raw);
  const canonical = parsed.ok ? parsed.title : null;

  useEffect(() => {
    if (canonical !== null && canonical !== raw) {
      void navigate({ to: "/wiki/$title", params: { title: canonical }, replace: true });
    }
  }, [canonical, raw, navigate]);

  if (canonical === null) {
    return <p className="py-16 text-center text-[12px] text-muted">That isn’t a valid wiki title.</p>;
  }
  // Keyed by title: following a link to another page starts on its View tab.
  return <PageView key={canonical} title={canonical} />;
}

/** The page `title` (already normalized) and its tabs. */
function PageView({ title }: { title: string }) {
  const { data: user } = useCurrentUser();
  const [tab, setTab] = useState<Tab>("view");
  const page = useQuery({ queryKey: pageKey(title), queryFn: () => fetchPage(title) });

  const isAdmin = user?.role === "admin";
  const tabs: { id: Tab; label: string }[] = [
    { id: "view", label: "View" },
    ...(user ? [{ id: "edit" as const, label: page.data ? "Edit" : "Create" }] : []),
    ...(page.data ? [{ id: "history" as const, label: "History" }] : []),
  ];
  // A tab can vanish (signed out, page deleted): fall back to View.
  const active = tabs.some((t) => t.id === tab) ? tab : "view";

  return (
    <div className="space-y-4">
      <div className="border-b border-line pb-2">
        <div className="text-[11px] text-muted">
          <Link to="/wiki" className="text-link hover:underline">
            Wiki
          </Link>{" "}
          ›
        </div>
        <h1 className="text-base font-bold">{displayTitle(title)}</h1>
        <p className="text-[12px] text-muted">
          <Link to="/posts" search={{ q: title }} className="text-link hover:underline">
            Posts tagged {title}
          </Link>
        </p>
      </div>

      <div role="tablist" aria-label="Wiki page" className="flex gap-1 border-b border-line text-[12px]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`wiki-tab-${t.id}`}
            aria-selected={active === t.id}
            aria-controls="wiki-tabpanel"
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t border px-3 py-1 ${
              active === t.id ? "border-line border-b-bg bg-bg font-bold" : "border-transparent text-link hover:underline"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="wiki-tabpanel" aria-labelledby={`wiki-tab-${active}`}>
        {page.isPending ? (
          <p className="text-[12px] text-muted">Loading…</p>
        ) : page.isError ? (
          <p role="alert" className="text-[12px] text-tag-artist">
            Couldn’t load the page.
          </p>
        ) : active === "edit" ? (
          <WikiEditor title={title} page={page.data} onDone={() => setTab("view")} />
        ) : active === "history" && page.data ? (
          <WikiHistory
            title={title}
            currentVersion={page.data.version}
            canRevert={isAdmin}
            onReverted={() => setTab("view")}
          />
        ) : page.data ? (
          <PageBody page={page.data} canDelete={isAdmin} />
        ) : (
          <div className="flex flex-col items-center gap-2 py-12 text-center text-[12px] text-muted">
            <BookOpen className="h-12 w-12 text-line" strokeWidth={1.25} aria-hidden="true" />
            <p>There’s no wiki page for “{title}” yet.</p>
            {user ? (
              <button type="button" onClick={() => setTab("edit")} className="rounded bg-link px-3 py-1 text-white">
                Create it
              </button>
            ) : (
              <p>
                <Link to="/login" className="text-link hover:underline">
                  Log in
                </Link>{" "}
                to write it.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The View tab: the rendered text, who last edited it, and (for an admin) Delete. */
function PageBody({ page, canDelete }: { page: WikiPageDto; canDelete: boolean }) {
  const tokens = useMemo(() => tokenize(page.body), [page.body]);
  return (
    <div className="max-w-3xl space-y-3">
      <WikiBody tokens={tokens} />
      <p className="text-[11px] text-muted">
        Version {page.version}
        {page.updatedByName ? `, edited by ${page.updatedByName}` : ""} on{" "}
        <time dateTime={page.updatedAt}>{new Date(page.updatedAt).toLocaleString()}</time>
      </p>
      {canDelete ? <DeletePage title={page.title} /> : null}
    </div>
  );
}
