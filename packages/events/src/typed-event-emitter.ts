/**
 * A tiny, dependency-free typed pub/sub emitter. Generic over an event map
 * (`{ "event.name": PayloadType }`) so callers get compile-time-checked event
 * names and payloads. The Core owns the concrete event map; plugins subscribe.
 *
 * Emission is **fire-and-forget and isolated**: listeners run synchronously in
 * registration order, but a throwing or rejecting listener can never fail or
 * delay `emit()` (errors are routed to `onListenerError`, default `console.error`).
 * This keeps side-effects (auto-tagging, thumbnails, …) from breaking the action
 * that triggered them — e.g. an upload must still succeed if a listener throws.
 */
export type EventListener<TPayload> = (payload: TPayload) => void | Promise<void>;

export interface TypedEventEmitter<TEventMap> {
  /** Subscribe; returns an unsubscribe function. */
  on<K extends keyof TEventMap>(event: K, listener: EventListener<TEventMap[K]>): () => void;
  /** Subscribe for a single emission; returns an unsubscribe function. */
  once<K extends keyof TEventMap>(event: K, listener: EventListener<TEventMap[K]>): () => void;
  /** Remove a previously registered listener. */
  off<K extends keyof TEventMap>(event: K, listener: EventListener<TEventMap[K]>): void;
  /** Publish an event to all listeners (non-blocking, error-isolated). */
  emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void;
}

export interface TypedEventEmitterOptions {
  /** Invoked when a listener throws or its promise rejects. Defaults to console.error. */
  onListenerError?: (error: unknown, event: string) => void;
}

/** Build a {@link TypedEventEmitter} over the given event map. */
export function createTypedEventEmitter<TEventMap>(
  options: TypedEventEmitterOptions = {},
): TypedEventEmitter<TEventMap> {
  const onListenerError =
    options.onListenerError ??
    ((error, event) => console.error(`[events] listener for "${event}" failed:`, error));

  // One listener set per event name. `unknown` payload internally; the public
  // generic signatures keep call sites type-safe.
  const registry = new Map<keyof TEventMap, Set<EventListener<unknown>>>();

  function add<K extends keyof TEventMap>(event: K, listener: EventListener<TEventMap[K]>): () => void {
    const set = registry.get(event) ?? new Set<EventListener<unknown>>();
    set.add(listener as EventListener<unknown>);
    registry.set(event, set);
    return () => set.delete(listener as EventListener<unknown>);
  }

  return {
    on: add,

    once(event, listener) {
      const remove = add(event, (payload) => {
        remove();
        return listener(payload);
      });
      return remove;
    },

    off(event, listener) {
      registry.get(event)?.delete(listener as EventListener<unknown>);
    },

    emit(event, payload) {
      const set = registry.get(event);
      if (!set) return;
      // Snapshot so a listener that (un)subscribes during dispatch can't disturb
      // this emission.
      for (const listener of [...set]) {
        try {
          const result = listener(payload);
          if (result instanceof Promise) result.catch((error) => onListenerError(error, String(event)));
        } catch (error) {
          onListenerError(error, String(event));
        }
      }
    },
  };
}
