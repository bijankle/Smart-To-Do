import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isKnownMusic, lookupMediaConcepts } from "../src/sync/webcheck.js";

describe("Background music check (MusicBrainz)", () => {
  it("requires a high-confidence exact name match", () => {
    const artists = [{ name: "Queen", score: 100 }];
    const recordings = [{ title: "Bohemian Rhapsody", score: 100 }];
    assert.equal(isKnownMusic("Queen", artists, recordings, []), true);
    assert.equal(isKnownMusic("Bohemian Rhapsody", artists, recordings, []), true);
    // Fuzzy low-score junk must not match.
    assert.equal(isKnownMusic("fix the fence", [{ name: "fix", score: 40 }], [], []), false);
  });

  it("tags a known artist and ignores obvious to-dos", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("/artist")) return { ok: true, json: async () => ({ artists: [{ name: "Flume", score: 100 }] }) } as Response;
      return { ok: true, json: async () => ({ recordings: [] }) } as Response;
    }) as unknown as typeof fetch;
    assert.deepEqual(await lookupMediaConcepts("listen to Flume", fakeFetch), ["music"]);

    const empty = (async () => ({ ok: true, json: async () => ({ artists: [], recordings: [] }) })) as unknown as typeof fetch;
    assert.deepEqual(await lookupMediaConcepts("email the accountant about tax", empty), []);
  });

  it("fails soft when offline", async () => {
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    assert.deepEqual(await lookupMediaConcepts("Flume", failing), []);
  });
});
