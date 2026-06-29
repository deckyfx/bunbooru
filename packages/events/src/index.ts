/**
 * `@bunbooru/events` — publish/subscribe event bus.
 *
 * Core emits events; plugins subscribe. Plugins never call each other directly.
 * Provides a generic, dependency-free {@link TypedEventEmitter}; the concrete
 * event map (e.g. `asset.created`) is defined by the Core that owns it.
 */
export const EVENTS_PACKAGE = "@bunbooru/events" as const;

export {
  createTypedEventEmitter,
  type EventListener,
  type TypedEventEmitter,
  type TypedEventEmitterOptions,
} from "./typed-event-emitter";
