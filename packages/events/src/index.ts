/**
 * `@bunbooru/events` — publish/subscribe event bus.
 *
 * Core emits events; plugins subscribe. Plugins never call each other directly.
 * The typed emitter implementation lands in a later PR.
 */
export const EVENTS_PACKAGE = "@bunbooru/events" as const;
