import { Component, Suspense, useMemo, type ErrorInfo, type ReactNode } from "react";

import { useCurrentUser } from "../lib/auth";
import { usePlugins } from "../lib/plugins";
import { PLUGIN_NAV, PLUGIN_UI } from "../plugins/registry";
import { selectEntries, type PluginNavLink, type SlotEntry, type SlotPropsMap, type UiSlot } from "../plugins/slots";

/** The ids of the plugins active on the server (empty until the manifest loads). */
export function useActivePluginIds(): { ids: ReadonlySet<string>; isLoading: boolean } {
  const plugins = usePlugins();
  const ids = useMemo(() => new Set((plugins.data ?? []).map((p) => p.id)), [plugins.data]);
  return { ids, isLoading: plugins.isLoading };
}

/** A slot's widgets to render now: active plugins, visible to the viewer, in order. */
export function useSlotEntries<S extends UiSlot>(slot: S): SlotEntry<S>[] {
  const { ids } = useActivePluginIds();
  const { data: user } = useCurrentUser();
  const entries = PLUGIN_UI[slot] as readonly SlotEntry<S>[];
  return useMemo(() => selectEntries(entries, ids, user, (e) => e.id), [entries, ids, user]);
}

/** The plugin menu links to show now. */
export function usePluginNavLinks(): PluginNavLink[] {
  const { ids } = useActivePluginIds();
  const { data: user } = useCurrentUser();
  return useMemo(() => selectEntries(PLUGIN_NAV, ids, user, (link) => link.label), [ids, user]);
}

/**
 * Contains one widget's failure. A public page renders widgets in front of every
 * visitor, so a throwing plugin must never take the page down with it: it
 * renders a small inline note, and keeps it until the page remounts rather than
 * retrying in a loop. (React only offers error boundaries as class components.)
 */
export class SlotErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`Plugin widget "${this.props.label}" failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p role="status" className="text-[12px] text-muted">
          {this.props.label} is unavailable right now.
        </p>
      );
    }
    return this.props.children;
  }
}

/** One widget, isolated: its own error boundary, and a loading state that takes no space. */
export function IsolatedWidget({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SlotErrorBoundary label={label}>
      {/* No fallback: a lazy widget renders nothing until ready rather than
          flashing a placeholder that shifts the layout. */}
      <Suspense fallback={null}>{children}</Suspense>
    </SlotErrorBoundary>
  );
}

/**
 * Render every widget plugins contribute to `slot`, each isolated, with the
 * props that slot defines. Renders nothing when no active plugin fills it.
 */
export function PluginSlot<S extends UiSlot>({
  slot,
  props,
  className,
}: {
  slot: S;
  props: SlotPropsMap[S];
  className?: string;
}) {
  const entries = useSlotEntries(slot);
  if (entries.length === 0) return null;
  return (
    <div className={className}>
      {entries.map((entry) => {
        const Widget = entry.component;
        return (
          <IsolatedWidget key={`${entry.pluginId}:${entry.id}`} label={entry.title}>
            <Widget {...props} />
          </IsolatedWidget>
        );
      })}
    </div>
  );
}
