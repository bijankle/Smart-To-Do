import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptForBucketName, matchConcept } from "../src/engine/lexicon.js";
import { tokenize } from "../src/engine/tokenize.js";
import { Repository } from "../src/storage/repo.js";
import { MemoryPersistence } from "../src/storage/persistence.js";

function makeOptions(startMs = 1_000_000) {
  let tick = 0;
  let id = 0;
  return {
    now: () => new Date(startMs + ++tick * 1000),
    newId: () => `task-${++id}`,
  };
}

describe("Seed lexicon", () => {
  it("maps bucket names and aliases to concepts", () => {
    assert.equal(conceptForBucketName("groceries")?.name, "groceries");
    assert.equal(conceptForBucketName("Food")?.name, "groceries");
    assert.equal(conceptForBucketName("Grocery Run")?.name, "groceries");
    assert.equal(conceptForBucketName("hardware")?.name, "hardware");
    assert.equal(conceptForBucketName("Tools")?.name, "hardware");
    assert.equal(conceptForBucketName("misc stuff"), null);
  });

  it("matches text to a concept only with 2+ distinct vocabulary hits", () => {
    assert.equal(matchConcept(tokenize("i need celery and onions"))?.concept.name, "groceries");
    assert.equal(matchConcept(tokenize("hammer and nails from the store"))?.concept.name, "hardware");
    assert.equal(matchConcept(tokenize("celery something unrelated")), null); // 1 hit
    assert.equal(matchConcept(tokenize("random musings about clouds")), null);
  });
});

describe("Repository — seeded buckets classify with zero training", () => {
  it("files grocery words into an existing untrained groceries bucket", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("hardware");
    const task = repo.addTask("i need celery and onions");
    assert.equal(task.bucket, "groceries");
    const hardwareTask = repo.addTask("hammer and nails for the fence");
    assert.equal(hardwareTask.bucket, "hardware");
  });

  it("user corrections still outweigh the seeds", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("baking");
    // The user repeatedly files flour/sugar tasks into their own "baking" bucket.
    repo.addTask("flour and sugar for the cake", "baking");
    repo.addTask("more flour and vanilla sugar", "baking");
    repo.addTask("sugar flour and baking soda", "baking");
    const next = repo.addTask("flour and sugar");
    assert.equal(next.bucket, "baking");
  });

  it("seeds buckets created before the lexicon existed (migration on open)", async () => {
    const persistence = new MemoryPersistence();
    const repo = await Repository.open(persistence, makeOptions());
    repo.createBucket("groceries");
    // Simulate a pre-lexicon store: strip the seeded flag and the model.
    const doc = JSON.parse(repo.exportDoc());
    delete doc.buckets["groceries"].seeded;
    doc.model = { version: 1, totalDocs: 0, buckets: {} };
    await persistence.save(JSON.stringify(doc));

    const reopened = await Repository.open(persistence, makeOptions(9_000_000));
    const task = reopened.addTask("i need celery and onions");
    assert.equal(task.bucket, "groceries");
  });
});

describe("Repository — reasonable auto-creation", () => {
  it("auto-creates a concept bucket on a clear 2-hit match", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const task = repo.addTask("i need celery and onions");
    assert.equal(task.bucket, "groceries");
    assert.ok(repo.listBuckets().includes("groceries"));
  });

  it("does not auto-create on a single everyday word", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const task = repo.addTask("watch the onion movie trailer");
    assert.equal(task.bucket, null);
    assert.deepEqual(repo.listBuckets(), []);
  });

  it("reuses an alias bucket instead of creating a duplicate concept", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Food");
    const task = repo.addTask("i need celery and onions");
    assert.equal(task.bucket, "Food");
    assert.deepEqual(repo.listBuckets(), ["Food"]);
  });

  it("never resurrects a bucket the user deleted", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.deleteBucket("groceries");
    const task = repo.addTask("i need celery and onions");
    assert.equal(task.bucket, null);
    assert.deepEqual(repo.listBuckets(), []);
  });
});
