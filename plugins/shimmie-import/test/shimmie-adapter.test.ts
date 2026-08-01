import { afterEach, describe, expect, it } from "bun:test";

import { ShimmieAdapter } from "../src/shimmie-adapter";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Route canned responses by URL so the adapter's flow can be tested offline. */
function mockFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(handler(String(input)))) as typeof fetch;
}

/** A local base URL, so the SSRF guard needs no DNS and permits http. */
const adapter = () => new ShimmieAdapter({ baseUrl: "http://127.0.0.1:5013", apiKey: "secret" });

describe("ShimmieAdapter.preflight", () => {
  it("returns the acting user + max id", async () => {
    mockFetch((url) => {
      if (url.includes("/graphql")) {
        return Response.json({ data: { me: { name: "decky", class: { name: "admin" } } } });
      }
      if (url.includes("/post/list/1")) {
        return new Response("<a href='/post/view/42'></a><a href='/post/view/7'></a>");
      }
      return new Response("", { status: 404 });
    });
    const result = await adapter().preflight();
    expect(result.actingUser).toBe("decky");
    expect(result.maxId).toBe(42);
  });

  it("rejects an Anonymous resolution (bad key / User API off)", async () => {
    mockFetch(() => Response.json({ data: { me: { name: "Anonymous", class: { name: "anonymous" } } } }));
    await expect(adapter().preflight()).rejects.toThrow(/Anonymous|api_key|User API/);
  });

  it("reports a missing GraphQL extension (404)", async () => {
    mockFetch(() => new Response("", { status: 404 }));
    await expect(adapter().preflight()).rejects.toThrow(/GraphQL endpoint not found/);
  });
});

describe("ShimmieAdapter.fetchPost", () => {
  it("maps GraphQL fields + scrapes the rating", async () => {
    mockFetch((url) => {
      if (url.includes("/graphql")) {
        return Response.json({
          data: {
            post: {
              hash: "436c5c59",
              ext: "jpg",
              width: 100,
              height: 200,
              mime: "image/jpeg",
              source: null,
              posted: "2024-08-27 14:35:34",
              owner: { name: "decky" },
              tags: ["female", "avatar"],
              image_link: "/_images/436c5c59/x.jpg",
            },
          },
        });
      }
      if (url.includes("/post/view/1")) {
        return new Response("<section data-rating='q'>...</section>");
      }
      return new Response("", { status: 404 });
    });
    const post = await adapter().fetchPost(1);
    expect(post).not.toBeNull();
    expect(post?.md5).toBe("436c5c59");
    expect(post?.rating).toBe("questionable");
    expect(post?.owner).toBe("decky");
    expect(post?.tags).toEqual(["female", "avatar"]);
    expect(post?.imageUrl).toBe("http://127.0.0.1:5013/_images/436c5c59/x.jpg");
    expect(post?.postUrl).toBe("http://127.0.0.1:5013/post/view/1");
    expect(post?.postedAt.getFullYear()).toBe(2024);
  });

  it("interprets naive dates in the configured source timezone (DST-correct)", async () => {
    mockFetch((url) => {
      if (url.includes("/graphql")) {
        return Response.json({
          data: {
            post: {
              hash: "h",
              ext: "png",
              width: 1,
              height: 1,
              mime: "image/png",
              source: null,
              posted: "2024-08-27 14:35:34",
              owner: { name: "u" },
              tags: [],
              image_link: "/_images/h/x.png",
            },
          },
        });
      }
      return new Response("<div data-rating='s'></div>");
    });
    // 14:35:34 in Asia/Jakarta (UTC+7) → 07:35:34 UTC.
    const jakarta = new ShimmieAdapter({
      baseUrl: "http://127.0.0.1:5013",
      apiKey: "k",
      timezone: "Asia/Jakarta",
    });
    const post = await jakarta.fetchPost(1);
    expect(post?.postedAt.toISOString()).toBe("2024-08-27T07:35:34.000Z");
  });

  it("returns null for a deleted / missing id", async () => {
    mockFetch((url) =>
      url.includes("/graphql") ? Response.json({ data: { post: null } }) : new Response("", { status: 404 }),
    );
    expect(await adapter().fetchPost(999)).toBeNull();
  });

  it("defaults to unrated when the rating attribute is absent", async () => {
    mockFetch((url) => {
      if (url.includes("/graphql")) {
        return Response.json({
          data: {
            post: {
              hash: "h",
              ext: "png",
              width: 1,
              height: 1,
              mime: "image/png",
              source: null,
              posted: "2024-01-01 00:00:00",
              owner: { name: "u" },
              tags: [],
              image_link: "/_images/h/x.png",
            },
          },
        });
      }
      return new Response("<div>no rating here</div>");
    });
    const post = await adapter().fetchPost(5);
    expect(post?.rating).toBe("unrated");
  });
});
