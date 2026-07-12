import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupProductConcepts } from "../src/sync/productlookup.js";
import { Repository } from "../src/storage/repo.js";
import { MemoryPersistence } from "../src/storage/persistence.js";

describe("Online product lookup", () => {
  it("maps a food product to groceries", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      assert.ok(String(input).includes("openfoodfacts"));
      return {
        ok: true,
        json: async () => ({
          products: [{ product_name: "Tim Tam Original", categories_tags: ["en:snacks", "en:biscuits"] }],
        }),
      } as Response;
    }) as unknown as typeof fetch;
    assert.deepEqual(await lookupProductConcepts("tim tams", fakeFetch), ["groceries"]);
  });

  it("maps a toiletry to chemist + groceries", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        products: [{ product_name: "Toothpaste Whitening", categories_tags: ["en:toothpastes", "en:oral-hygiene"] }],
      }),
    })) as unknown as typeof fetch;
    assert.deepEqual(await lookupProductConcepts("whitening toothpaste", fakeFetch), ["chemist", "groceries"]);
  });

  it("falls back to Open Beauty Facts when food search misses", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("openfoodfacts")) return { ok: true, json: async () => ({ products: [] }) } as Response;
      // Open Beauty Facts hit
      return {
        ok: true,
        json: async () => ({ products: [{ product_name: "Micellar Water", categories_tags: ["en:cleansers"] }] }),
      } as Response;
    }) as unknown as typeof fetch;
    assert.deepEqual(await lookupProductConcepts("micellar water", fakeFetch), ["chemist", "groceries"]);
  });

  it("returns nothing for an unrelated match (name must overlap the query)", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ products: [{ product_name: "Something Else", categories_tags: ["en:snacks"] }] }),
    })) as unknown as typeof fetch;
    assert.deepEqual(await lookupProductConcepts("aux cable", fakeFetch), []);
  });

  it("fails soft when offline", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.deepEqual(await lookupProductConcepts("anything", failing), []);
  });

  it("applies looked-up concepts to a task via the repository", async () => {
    let tick = 0;
    const repo = await Repository.open(new MemoryPersistence(), {
      now: () => new Date(1_000_000 + ++tick * 1000),
      newId: () => `task-${tick}`,
    });
    repo.createBucket("Coles");
    repo.createBucket("Chemist Warehouse");
    const task = repo.addTask("some obscure brand snack");
    assert.deepEqual(task.buckets, []); // lexicon can't place it

    const buckets = [...new Set(["groceries"].flatMap((c) => repo.bucketsForConceptName(c)))];
    assert.deepEqual(buckets, ["Coles"]);
    assert.equal(repo.setSuggestedTags(task.id, buckets), true);
    assert.deepEqual(repo.getTask(task.id)!.buckets, ["Coles"]);

    // Timid: never overrides a task the user has hand-tagged.
    repo.toggleBucket(task.id, "Chemist Warehouse");
    assert.equal(repo.setSuggestedTags(task.id, ["Coles"]), false);
  });
});
