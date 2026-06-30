import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFilesystemStorageProvider, type StorageProvider } from "../src/index";

/** Read a stream fully into a string for assertions. */
async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("FilesystemStorageProvider", () => {
  let root: string;
  let storage: StorageProvider;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bunbooru-storage-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Fresh provider over the same root; tests clean up their own keys.
  beforeEach(() => {
    storage = createFilesystemStorageProvider({ root });
  });

  it("stores Uint8Array data and reads it back via stream", async () => {
    await storage.store("a/b/hello.txt", bytes("hello world"));
    expect(await storage.exists("a/b/hello.txt")).toBe(true);
    expect(await read(await storage.stream("a/b/hello.txt"))).toBe("hello world");
  });

  it("stores from a ReadableStream", async () => {
    const body = new Response("streamed bytes").body;
    if (!body) throw new Error("expected a response body");
    await storage.store("streamed.bin", body);
    expect(await read(await storage.stream("streamed.bin"))).toBe("streamed bytes");
  });

  it("reports non-existent keys as absent", async () => {
    expect(await storage.exists("nope/missing.txt")).toBe(false);
  });

  it("throws when streaming a missing object", async () => {
    await expect(storage.stream("nope/missing.txt")).rejects.toThrow(/not found/);
  });

  it("deletes an object (and delete is idempotent)", async () => {
    await storage.store("del.txt", bytes("x"));
    await storage.delete("del.txt");
    expect(await storage.exists("del.txt")).toBe(false);
    await expect(storage.delete("del.txt")).resolves.toBeUndefined(); // no throw
  });

  it("copies an object, leaving the source in place", async () => {
    await storage.store("src/copy.txt", bytes("payload"));
    await storage.copy("src/copy.txt", "dst/copy.txt");
    expect(await storage.exists("src/copy.txt")).toBe(true);
    expect(await read(await storage.stream("dst/copy.txt"))).toBe("payload");
  });

  it("moves an object, removing the source", async () => {
    await storage.store("src/move.txt", bytes("payload"));
    await storage.move("src/move.txt", "dst/move.txt");
    expect(await storage.exists("src/move.txt")).toBe(false);
    expect(await read(await storage.stream("dst/move.txt"))).toBe("payload");
  });

  it("lists stored objects under a prefix with a modified time", async () => {
    await storage.store("assets/aa/one.bin", bytes("1"));
    await storage.store("assets/bb/two.bin", bytes("2"));
    await storage.store("other/three.bin", bytes("3"));

    const seen = new Map<string, Date>();
    for await (const object of storage.list("assets/")) seen.set(object.key, object.modifiedAt);

    expect([...seen.keys()].sort()).toEqual(["assets/aa/one.bin", "assets/bb/two.bin"]);
    expect(seen.get("assets/aa/one.bin")).toBeInstanceOf(Date);
    // Clean up so the shared-root list stays predictable for other tests.
    await storage.delete("assets/aa/one.bin");
    await storage.delete("assets/bb/two.bin");
    await storage.delete("other/three.bin");
  });

  it("statModifiedAt returns a Date for a stored object and null when absent", async () => {
    await storage.store("assets/dd/stat.bin", bytes("x"));
    expect(await storage.statModifiedAt("assets/dd/stat.bin")).toBeInstanceOf(Date);
    expect(await storage.statModifiedAt("assets/dd/missing.bin")).toBeNull();
    await storage.delete("assets/dd/stat.bin");
  });

  it("ingestLocalFile moves a local file into the store, consuming the source", async () => {
    const localPath = join(root, "incoming.bin");
    await Bun.write(localPath, "ingest me");
    await storage.ingestLocalFile?.(localPath, "assets/cc/ingested.bin");
    // Source consumed; content now lives at the key.
    expect(await Bun.file(localPath).exists()).toBe(false);
    expect(await read(await storage.stream("assets/cc/ingested.bin"))).toBe("ingest me");
    await storage.delete("assets/cc/ingested.bin");
  });

  it("exposes no public URL for a private filesystem backend", async () => {
    expect(await storage.getPublicUrl("a/b/hello.txt")).toBeNull();
  });

  describe("path-traversal safety", () => {
    it("rejects a key that escapes the root", async () => {
      await expect(storage.store("../escape.txt", bytes("x"))).rejects.toThrow(/escape/);
    });

    it("rejects an absolute key", async () => {
      await expect(storage.store("/etc/passwd", bytes("x"))).rejects.toThrow(/escape/);
    });

    it("rejects an absolute key even when it points inside root", async () => {
      await expect(storage.store(join(root, "inside.txt"), bytes("x"))).rejects.toThrow(/escape/);
    });

    it("creates no destination dirs when the source key is invalid", async () => {
      await expect(storage.copy("../bad", "fresh/dir/x.txt")).rejects.toThrow(/escape/);
      await expect(stat(join(root, "fresh"))).rejects.toThrow(); // dir never created
    });

    it("rejects traversal on the copy/move destination, leaving the source intact", async () => {
      await storage.store("ok.txt", bytes("x"));
      await expect(storage.copy("ok.txt", "../out.txt")).rejects.toThrow(/escape/);
      await expect(storage.move("ok.txt", "../../out.txt")).rejects.toThrow(/escape/);
      // A rejected move must not have removed the source.
      expect(await storage.exists("ok.txt")).toBe(true);
    });

    it("rejects traversal on the copy/move source", async () => {
      await expect(storage.copy("../escape.txt", "in.txt")).rejects.toThrow(/escape/);
      await expect(storage.move("../escape.txt", "in.txt")).rejects.toThrow(/escape/);
    });

    it("rejects traversal on read and delete paths", async () => {
      await expect(storage.stream("../escape.txt")).rejects.toThrow(/escape/);
      await expect(storage.delete("../escape.txt")).rejects.toThrow(/escape/);
    });
  });
});
