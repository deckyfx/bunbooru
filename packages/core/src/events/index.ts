import { createTypedEventEmitter, type TypedEventEmitter } from "@bunbooru/events";
import type { Asset } from "@bunbooru/db";

/**
 * Payload for {@link CoreEventMap}'s `asset.created` — emitted once a brand-new
 * asset has been stored and persisted (not on a dedupe hit). Future plugins
 * (auto-tagging, similar-image finder, thumbnailing, OCR…) subscribe to this to
 * react to uploads without the Core knowing they exist (CLAUDE.md Event Rule).
 */
export interface AssetCreatedEvent {
  id: number;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  rating: Asset["rating"];
  source: string | null;
  createdAt: Date;
}

/** The Core's event map — the single source of truth for emit/subscribe types. */
export interface CoreEventMap {
  "asset.created": AssetCreatedEvent;
}

/** The Core's typed event bus. */
export type CoreEvents = TypedEventEmitter<CoreEventMap>;

/** Construct the Core event bus. */
export function createCoreEvents(): CoreEvents {
  return createTypedEventEmitter<CoreEventMap>();
}
