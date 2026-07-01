import { describe, expect, it } from "bun:test";

import type { SettingsRepository } from "@bunbooru/db";

import { ValidationError } from "../src/errors";
import { createSettingsService } from "../src/services/settings-service";

/** In-memory {@link SettingsRepository} recording the `setMany` calls it received. */
function fakeRepo(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const calls: Array<{ entries: Array<{ key: string; value: string }>; updatedBy: number | null }> = [];
  const repo: SettingsRepository = {
    getAll: async () => ({ ...store }),
    setMany: async (entries, updatedBy) => {
      for (const { key, value } of entries) store[key] = value;
      calls.push({ entries: entries.map(({ key, value }) => ({ key, value })), updatedBy });
    },
  };
  return { repo, calls };
}

const defaults = { maxUploadBytes: 1000, maxResumableUploadBytes: 5000 };
const CEILING = 2000;

function makeService(initial: Record<string, string> = {}) {
  const { repo, calls } = fakeRepo(initial);
  const service = createSettingsService(repo, { defaults, requestBodyCeilingBytes: CEILING });
  return { service, calls };
}

describe("createSettingsService", () => {
  it("returns the env defaults when nothing is overridden", async () => {
    const { service } = makeService();
    expect(await service.getUploadLimits()).toEqual(defaults);
  });

  it("applies a DB override over the default", async () => {
    const { service } = makeService({ max_upload_bytes: "1500" });
    expect(await service.getUploadLimits()).toEqual({
      maxUploadBytes: 1500,
      maxResumableUploadBytes: 5000,
    });
  });

  it("ignores a corrupt override, falling back to the default", async () => {
    const { service } = makeService({ max_upload_bytes: "not-a-number" });
    expect((await service.getUploadLimits()).maxUploadBytes).toBe(1000);
  });

  it("persists + caches an update and records the editor", async () => {
    const { service, calls } = makeService();
    const next = await service.updateUploadLimits({ maxUploadBytes: 1500 }, 42);
    expect(next).toEqual({ maxUploadBytes: 1500, maxResumableUploadBytes: 5000 });
    // Only the changed key is written (atomically), with the editor id.
    expect(calls).toEqual([{ entries: [{ key: "max_upload_bytes", value: "1500" }], updatedBy: 42 }]);
    // A subsequent read reflects the update.
    expect(await service.getUploadLimits()).toEqual({ maxUploadBytes: 1500, maxResumableUploadBytes: 5000 });
  });

  it("rejects a one-shot cap above the request-body ceiling", async () => {
    const { service } = makeService();
    await expect(service.updateUploadLimits({ maxUploadBytes: CEILING + 1 }, null)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("allows a resumable cap above the ceiling (chunked, not a body limit)", async () => {
    const { service } = makeService();
    const next = await service.updateUploadLimits({ maxResumableUploadBytes: CEILING * 100 }, null);
    expect(next.maxResumableUploadBytes).toBe(CEILING * 100);
  });

  it("rejects a non-positive cap", async () => {
    const { service } = makeService();
    await expect(service.updateUploadLimits({ maxUploadBytes: 0 }, null)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
