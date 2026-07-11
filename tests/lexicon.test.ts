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

  it("covers the go-to-places categories: electronics and computer tasks", async () => {
    assert.equal(conceptForBucketName("electronics")?.name, "electronics");
    assert.equal(conceptForBucketName("Tech")?.name, "electronics");
    assert.equal(conceptForBucketName("computer")?.name, "computer");
    assert.equal(conceptForBucketName("Medical")?.name, "health");

    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("electronics");
    repo.createBucket("computer");
    repo.addTask("hdmi cable and a phone charger"); // list → split into children
    assert.deepEqual(repo.listTasks("electronics").map((t) => t.title), ["hdmi cable", "phone charger"]);
    repo.addTask("backup the photo folder and update drivers");
    assert.deepEqual(repo.listTasks("computer").map((t) => t.title), ["backup photo folder", "update drivers"]);
  });

  it("matches text to a concept only with 2+ distinct vocabulary hits", () => {
    assert.equal(matchConcept(tokenize("i need celery and onions"))?.concept.name, "groceries");
    assert.equal(matchConcept(tokenize("hammer and nails from the store"))?.concept.name, "hardware");
    assert.equal(matchConcept(tokenize("celery something unrelated")), null); // 1 hit
    assert.equal(matchConcept(tokenize("random musings about clouds")), null);
  });
});

describe("Repository — seeded buckets classify with zero training", () => {
  it("splits list captures into per-item children in the bucket, parent stays in All", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("hardware");

    const parent = repo.addTask("i need celery and onions");
    assert.equal(parent.bucket, null);
    assert.equal(parent.childIds?.length, 2);
    assert.deepEqual(repo.listTasks("groceries").map((t) => t.title), ["celery", "onions"]);
    // Parent is categorized-by-proxy: visible in All, NOT in the Inbox pill.
    assert.ok(repo.listTasks("all").some((t) => t.id === parent.id));
    assert.equal(repo.listTasks("inbox").length, 0);

    repo.addTask("hammer and nails for the fence");
    assert.deepEqual(repo.listTasks("hardware").map((t) => t.title), ["hammer", "nails"]);
  });

  it("completing the parent completes its children (and back)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    const parent = repo.addTask("i need celery and onions");

    repo.setDone(parent.id, true);
    assert.equal(repo.listTasks("groceries").length, 0);
    assert.deepEqual(
      repo.listCompleted("groceries").map((t) => t.done),
      [true, true],
    );

    repo.setDone(parent.id, false);
    assert.equal(repo.listTasks("groceries").length, 2);
  });

  it("does not split non-list captures or mixed text", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    // "mac" has no vocabulary hit, so the capture stays whole.
    const task = repo.addTask("mac and cheese");
    assert.equal(task.childIds, undefined);
  });

  it("files a single strong word into its concept bucket ('laptop' → electronics)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("electronics");
    assert.equal(repo.addTask("laptop").bucket, "electronics");

    // And auto-creates the bucket when it doesn't exist yet.
    const fresh = await Repository.open(new MemoryPersistence(), makeOptions());
    assert.equal(fresh.addTask("laptop").bucket, "electronics");
    assert.ok(fresh.listBuckets().includes("electronics"));
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
    const task = reopened.addTask("i need celery");
    assert.equal(task.bucket, "groceries");
  });
});

describe("Repository — reasonable auto-creation", () => {
  it("auto-creates a concept bucket on a clear 2-hit match", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.addTask("i need celery and onions");
    assert.ok(repo.listBuckets().includes("groceries"));
    assert.deepEqual(repo.listTasks("groceries").map((t) => t.title), ["celery", "onions"]);
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
    repo.addTask("i need celery and onions");
    assert.deepEqual(repo.listBuckets(), ["Food"]);
    assert.deepEqual(repo.listTasks("Food").map((t) => t.title), ["celery", "onions"]);
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
