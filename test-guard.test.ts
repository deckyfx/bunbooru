import { describe, expect, it } from "bun:test";

import { databaseName, isLoopbackHost, target, unsafeTestDatabaseReason } from "./test-guard";

/**
 * The destructive-write guard. These cases are the ones that already cost this
 * repo its dev database once — a `TEST_DATABASE_URL` resolving to the same
 * Postgres as `DATABASE_URL`, spelled differently enough to look distinct.
 */
describe("isLoopbackHost", () => {
  it("accepts every spelling of the local machine", () => {
    for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects remote hosts, including look-alikes", () => {
    for (const host of ["db.internal", "10.0.0.1", "192.168.0.102", "1270.0.0.1", "227.0.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("does not treat a DNS name beginning '127.' as loopback", () => {
    // A prefix match would map these REMOTE hosts onto localhost, where they could
    // compare equal to the dev database and block a legitimate test URL.
    for (const host of ["127.example.com", "127.0.0.1.evil.test", "127.foo"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("rejects IPv4 literals with out-of-range octets", () => {
    for (const host of ["127.0.0.256", "127.999.0.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("target", () => {
  it("ignores credentials — only host, port and database identify a target", () => {
    expect(target("postgres://a:b@localhost:5432/bunbooru")).toBe(
      target("postgres://c:d@localhost:5432/bunbooru"),
    );
  });

  it("defaults the port, so an implicit 5432 matches an explicit one", () => {
    expect(target("postgres://localhost/bunbooru")).toBe(target("postgres://localhost:5432/bunbooru"));
  });

  it("distinguishes different databases on the same server", () => {
    expect(target("postgres://localhost:5432/bunbooru")).not.toBe(
      target("postgres://localhost:5432/bunbooru_test"),
    );
  });

  it("returns null for an unparseable URL", () => {
    expect(target("not a url")).toBeNull();
  });
});

describe("databaseName", () => {
  it("extracts the name and returns null when there is none", () => {
    expect(databaseName("postgres://localhost:5432/bunbooru_test")).toBe("bunbooru_test");
    expect(databaseName("postgres://localhost:5432/")).toBeNull();
    expect(databaseName("nonsense")).toBeNull();
  });
});

describe("unsafeTestDatabaseReason", () => {
  const dev = "postgres://bunbooru:pw@localhost:5432/bunbooru";

  it("allows a properly-named throwaway database", () => {
    expect(
      unsafeTestDatabaseReason("postgres://bunbooru:pw@localhost:5432/bunbooru_test", dev),
    ).toBeNull();
  });

  it("allows an unset variable (the suites simply skip)", () => {
    expect(unsafeTestDatabaseReason(undefined, dev)).toBeNull();
    expect(unsafeTestDatabaseReason("   ", dev)).toBeNull();
  });

  it("rejects the dev database even when spelled differently", () => {
    // Different credentials, different loopback spelling, implicit port — all the
    // ways the same database can fail to look like itself.
    for (const testUrl of [
      "postgres://other:pw@127.0.0.1:5432/bunbooru",
      "postgres://other:pw@127.0.0.2:5432/bunbooru",
      "postgres://bunbooru:pw@localhost/bunbooru",
    ]) {
      expect(unsafeTestDatabaseReason(testUrl, dev)).toContain("same database");
    }
  });

  it("rejects a name that is not marked disposable, even with DATABASE_URL unset", () => {
    const reason = unsafeTestDatabaseReason("postgres://u:p@db.example:5432/production", undefined);
    expect(reason).toContain('does not end in "_test"');
  });

  it("rejects a URL with NO database at all", () => {
    // The driver would connect to a server default — commonly the role's own
    // database — which is exactly the un-vetted target this rule exists to stop.
    for (const testUrl of [
      "postgres://user:password@localhost",
      "postgres://user:password@localhost:5432/",
    ]) {
      expect(unsafeTestDatabaseReason(testUrl, undefined)).toContain('does not end in "_test"');
    }
  });

  it("allows a remote host that merely shares the dev database's name", () => {
    // Same database NAME on a different server is a different database.
    expect(
      unsafeTestDatabaseReason("postgres://u:p@db.example:5432/bunbooru_test", dev),
    ).toBeNull();
  });
});
