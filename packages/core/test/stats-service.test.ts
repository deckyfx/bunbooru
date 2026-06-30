import { describe, expect, it } from "bun:test";

import type { StatsRepository } from "@bunbooru/db";

import { createStatsService } from "../src/services/stats-service";

/** A fake {@link StatsRepository} that records the args it was called with. */
function fakeStatsRepo(overrides: Partial<StatsRepository> = {}) {
  const calls = {
    view: [] as { visitorId: string; assetId: number; windowMs: number }[],
    visit: [] as { visitorId: string; day: string }[],
    visitorCountDay: [] as string[],
  };
  const repo: StatsRepository = {
    recordView: async (visitorId, assetId, windowMs) => {
      calls.view.push({ visitorId, assetId, windowMs });
      return true;
    },
    recordVisit: async (visitorId, day) => {
      calls.visit.push({ visitorId, day });
    },
    visitorCount: async (day) => {
      calls.visitorCountDay.push(day);
      return 7;
    },
    postCount: async () => 42,
    ...overrides,
  };
  return { repo, calls };
}

describe("createStatsService", () => {
  it("records a view with a 30-minute debounce window and returns whether it counted", async () => {
    const { repo, calls } = fakeStatsRepo();
    const service = createStatsService(repo);

    expect(await service.recordView("v1", 5)).toBe(true);
    expect(calls.view).toEqual([{ visitorId: "v1", assetId: 5, windowMs: 30 * 60 * 1000 }]);
  });

  it("passes through a debounced (false) view result", async () => {
    const { repo } = fakeStatsRepo({ recordView: async () => false });
    expect(await createStatsService(repo).recordView("v1", 5)).toBe(false);
  });

  it("records a visit bucketed by today's UTC date", async () => {
    const { repo, calls } = fakeStatsRepo();
    const service = createStatsService(repo, () => new Date("2026-03-15T23:59:59.000Z"));

    await service.recordVisit("v1");
    expect(calls.visit).toEqual([{ visitorId: "v1", day: "2026-03-15" }]);
  });

  it("combines total posts and today's visitor count", async () => {
    const { repo, calls } = fakeStatsRepo();
    const service = createStatsService(repo, () => new Date("2026-03-15T08:00:00.000Z"));

    expect(await service.getStats()).toEqual({ posts: 42, visitorsToday: 7 });
    expect(calls.visitorCountDay).toEqual(["2026-03-15"]);
  });
});
