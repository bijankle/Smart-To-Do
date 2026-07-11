import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptsFromResults, lookupMediaConcepts } from "../src/sync/webcheck.js";

describe("Background media check (iTunes catalogue)", () => {
  it("maps result kinds to concepts, requiring an exact name match", () => {
    const results = [
      { kind: "song", trackName: "Bohemian Rhapsody", artistName: "Queen" },
      { kind: "feature-movie", trackName: "Dune" },
      { kind: "ebook", trackName: "Project Hail Mary", artistName: "Andy Weir" },
      { wrapperType: "artist", artistName: "Flume" },
    ];
    assert.deepEqual(conceptsFromResults("bohemian rhapsody", results), ["music"]);
    assert.deepEqual(conceptsFromResults("dune", results), ["films"]);
    assert.deepEqual(conceptsFromResults("project hail mary", results), ["books"]);
    assert.deepEqual(conceptsFromResults("flume", results), ["music"]);
    // Fuzzy iTunes noise must NOT match: no result is named "fix the fence".
    assert.deepEqual(conceptsFromResults("fix the fence", results), []);
  });

  it("strips capture verbs and survives network failure silently", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return {
        ok: true,
        json: async () => ({
          results: [{ kind: "feature-movie", trackName: "Oppenheimer" }],
        }),
      } as Response;
    }) as typeof fetch;

    const concepts = await lookupMediaConcepts("watch oppenheimer", fakeFetch);
    assert.deepEqual(concepts, ["films"]);
    assert.ok(seen[0]!.includes("term=oppenheimer"));

    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.deepEqual(await lookupMediaConcepts("watch oppenheimer", failing), []);
  });
});
