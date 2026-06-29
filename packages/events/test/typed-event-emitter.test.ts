import { describe, expect, it } from "bun:test";

import { createTypedEventEmitter } from "../src/typed-event-emitter";

interface TestMap {
  ping: { n: number };
  other: { s: string };
}

describe("createTypedEventEmitter", () => {
  it("delivers a payload to a subscriber", () => {
    const bus = createTypedEventEmitter<TestMap>();
    const seen: number[] = [];
    bus.on("ping", (p) => {
      seen.push(p.n);
    });
    bus.emit("ping", { n: 1 });
    bus.emit("ping", { n: 2 });
    expect(seen).toEqual([1, 2]);
  });

  it("delivers to multiple listeners and isolates events by name", () => {
    const bus = createTypedEventEmitter<TestMap>();
    const a: number[] = [];
    const b: number[] = [];
    const other: string[] = [];
    bus.on("ping", (p) => {
      a.push(p.n);
    });
    bus.on("ping", (p) => {
      b.push(p.n);
    });
    bus.on("other", (p) => {
      other.push(p.s);
    });
    bus.emit("ping", { n: 7 });
    expect(a).toEqual([7]);
    expect(b).toEqual([7]);
    expect(other).toEqual([]);
  });

  it("on() returns an unsubscribe function", () => {
    const bus = createTypedEventEmitter<TestMap>();
    const seen: number[] = [];
    const off = bus.on("ping", (p) => {
      seen.push(p.n);
    });
    bus.emit("ping", { n: 1 });
    off();
    bus.emit("ping", { n: 2 });
    expect(seen).toEqual([1]);
  });

  it("off() removes a listener", () => {
    const bus = createTypedEventEmitter<TestMap>();
    const seen: number[] = [];
    const listener = (p: { n: number }) => {
      seen.push(p.n);
    };
    bus.on("ping", listener);
    bus.off("ping", listener);
    bus.emit("ping", { n: 1 });
    expect(seen).toEqual([]);
  });

  it("once() fires at most once", () => {
    const bus = createTypedEventEmitter<TestMap>();
    const seen: number[] = [];
    bus.once("ping", (p) => {
      seen.push(p.n);
    });
    bus.emit("ping", { n: 1 });
    bus.emit("ping", { n: 2 });
    expect(seen).toEqual([1]);
  });

  it("isolates a throwing listener: others still run, emit never throws", () => {
    const errors: string[] = [];
    const bus = createTypedEventEmitter<TestMap>({
      onListenerError: (_e, event) => errors.push(event),
    });
    const seen: number[] = [];
    bus.on("ping", () => {
      throw new Error("boom");
    });
    bus.on("ping", (p) => {
      seen.push(p.n);
    });
    expect(() => bus.emit("ping", { n: 5 })).not.toThrow();
    expect(seen).toEqual([5]); // the second listener still ran
    expect(errors).toEqual(["ping"]);
  });

  it("does not throw even if onListenerError itself throws", () => {
    const bus = createTypedEventEmitter<TestMap>({
      onListenerError: () => {
        throw new Error("hook boom");
      },
    });
    bus.on("ping", () => {
      throw new Error("listener boom");
    });
    expect(() => bus.emit("ping", { n: 1 })).not.toThrow();
  });

  it("routes an async listener rejection to onListenerError without throwing", async () => {
    let caught: unknown;
    const bus = createTypedEventEmitter<TestMap>({
      onListenerError: (e) => {
        caught = e;
      },
    });
    bus.on("ping", async () => {
      throw new Error("async boom");
    });
    bus.emit("ping", { n: 1 });
    await Promise.resolve(); // let the rejected microtask settle
    expect(caught).toBeInstanceOf(Error);
  });
});
