import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptForBucketName, matchConcepts } from "../src/engine/lexicon.js";
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

const names = (concepts: Array<{ name: string }>) => concepts.map((c) => c.name).sort();

describe("Seed lexicon", () => {
  it("maps bucket names and aliases to concepts", () => {
    assert.equal(conceptForBucketName("groceries")?.name, "groceries");
    assert.equal(conceptForBucketName("Food")?.name, "groceries");
    assert.equal(conceptForBucketName("Grocery Run")?.name, "groceries");
    assert.equal(conceptForBucketName("hardware")?.name, "hardware");
    assert.equal(conceptForBucketName("Tools")?.name, "hardware");
    assert.equal(conceptForBucketName("Medical")?.name, "health");
    assert.equal(conceptForBucketName("electronics")?.name, "electronics");
    assert.equal(conceptForBucketName("computer")?.name, "computer");
    assert.equal(conceptForBucketName("misc stuff"), null);
  });

  it("matches strong multi-hit concepts", () => {
    assert.deepEqual(names(matchConcepts(tokenize("i need celery and onions"))), ["groceries"]);
    assert.deepEqual(names(matchConcepts(tokenize("hammer and nails from the store"))), ["hardware"]);
  });

  it("matches a mixed capture to several concepts", () => {
    assert.deepEqual(names(matchConcepts(tokenize("buy onions and a hammer"))), [
      "groceries",
      "hardware",
    ]);
    // A strong concept must not drown out an unrelated single item.
    assert.deepEqual(names(matchConcepts(tokenize("celery and a drill bit"))), [
      "groceries",
      "hardware",
    ]);
  });

  it("recognizes store names and medical phrasing", () => {
    assert.equal(conceptForBucketName("Bunnings")?.name, "hardware");
    assert.equal(conceptForBucketName("JB Hi-Fi")?.name, "electronics");
    assert.equal(conceptForBucketName("jbhifi")?.name, "electronics");
    assert.equal(conceptForBucketName("Woolworths")?.name, "groceries");
    assert.equal(conceptForBucketName("Coles")?.name, "groceries");
    assert.equal(conceptForBucketName("Chemist Warehouse")?.name, "health");
    assert.equal(conceptForBucketName("Officeworks")?.name, "electronics");
    assert.equal(conceptForBucketName("Ikea")?.name, "home");
    assert.equal(conceptForBucketName("Kmart")?.name, "home");
    assert.equal(conceptForBucketName("Uniqlo")?.name, "clothing");
    assert.deepEqual(names(matchConcepts(tokenize("get a medical assessment"))), ["health"]);
  });

  it("files clothing and stationery runs into store buckets", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("uniqlo");
    repo.createBucket("Officeworks");
    assert.deepEqual(repo.addTask("socks and a hoodie").buckets, ["uniqlo"]);
    assert.deepEqual(repo.addTask("stapler and highlighters").buckets, ["Officeworks"]);
  });

  it("matches a decisive single word ('laptop')", () => {
    assert.deepEqual(names(matchConcepts(tokenize("laptop"))), ["electronics"]);
  });

  it("stays quiet on incidental single words in longer text", () => {
    assert.deepEqual(matchConcepts(tokenize("watch the onion movie trailer")), []);
    assert.deepEqual(matchConcepts(tokenize("celery something unrelated")), []);
    assert.deepEqual(matchConcepts(tokenize("random musings about clouds")), []);
  });
});

describe("Repository — multi-bucket tagging", () => {
  it("tags a mixed capture into multiple buckets as ONE task", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("hardware");
    const task = repo.addTask("buy onions and a hammer");
    assert.deepEqual([...task.buckets].sort(), ["groceries", "hardware"]);
    assert.equal(repo.listTasks("all").length, 1);
    assert.equal(repo.listTasks("groceries")[0]!.id, task.id);
    assert.equal(repo.listTasks("hardware")[0]!.id, task.id);
  });

  it("store-name buckets behave as their category (Bunnings, JB Hi-Fi)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Bunnings");
    repo.createBucket("JB Hi-Fi");
    assert.deepEqual(repo.addTask("screws and paint").buckets, ["Bunnings"]);
    assert.deepEqual(repo.addTask("hdmi cable and a charger").buckets, ["JB Hi-Fi"]);
    const mixed = repo.addTask("drill bits and a webcam");
    assert.deepEqual([...mixed.buckets].sort(), ["Bunnings", "JB Hi-Fi"]);
  });

  it("files medical phrasing into a medical bucket", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("medical");
    assert.deepEqual(repo.addTask("get a medical assessment").buckets, ["medical"]);
  });

  it("renaming an untagged task re-runs auto-tagging (typo fix)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("medical");
    const task = repo.addTask("get a medcical asessment"); // typos → untagged
    assert.deepEqual(task.buckets, []);
    repo.renameTask(task.id, "get a medical assessment");
    assert.deepEqual(repo.getTask(task.id)!.buckets, ["medical"]);
  });

  it("keeps a same-category list as one task in that bucket", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    const task = repo.addTask("i need celery and onions");
    assert.deepEqual(task.buckets, ["groceries"]);
    assert.equal(repo.listTasks("groceries").length, 1);
  });

  it("completing the task anywhere completes it everywhere", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("hardware");
    const task = repo.addTask("buy onions and a hammer");
    repo.setDone(task.id, true);
    assert.equal(repo.listTasks("groceries").length, 0);
    assert.equal(repo.listTasks("hardware").length, 0);
    assert.equal(repo.listCompleted("groceries").length, 1);
    assert.equal(repo.listCompleted("hardware").length, 1);
  });

  it("files a single strong word ('laptop' → electronics) into an existing bucket", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("electronics");
    assert.deepEqual(repo.addTask("laptop").buckets, ["electronics"]);
  });

  it("toggleBucket adds and removes memberships, training both ways", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("hardware");
    const task = repo.addTask("mystery errand zzz");
    assert.deepEqual(task.buckets, []);

    repo.toggleBucket(task.id, "groceries");
    repo.toggleBucket(task.id, "hardware");
    assert.deepEqual([...repo.getTask(task.id)!.buckets].sort(), ["groceries", "hardware"]);

    repo.toggleBucket(task.id, "groceries");
    assert.deepEqual(repo.getTask(task.id)!.buckets, ["hardware"]);
  });

  it("covers electronics and computer-task captures", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("electronics");
    repo.createBucket("computer");
    assert.deepEqual(repo.addTask("hdmi cable and a phone charger").buckets, ["electronics"]);
    assert.deepEqual(repo.addTask("backup the photo folder and update drivers").buckets, ["computer"]);
  });

  it("user corrections still outweigh the seeds", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.createBucket("baking");
    repo.addTask("flour and sugar for the cake", "baking");
    repo.addTask("more flour and vanilla sugar", "baking");
    repo.addTask("sugar flour and baking soda", "baking");
    const next = repo.addTask("flour and sugar");
    assert.deepEqual(next.buckets, ["baking"]);
  });

  it("seeds buckets created before the lexicon existed (migration on open)", async () => {
    const persistence = new MemoryPersistence();
    const repo = await Repository.open(persistence, makeOptions());
    repo.createBucket("groceries");
    const doc = JSON.parse(repo.exportDoc());
    delete doc.buckets["groceries"].seeded;
    doc.model = { version: 1, totalDocs: 0, buckets: {} };
    await persistence.save(JSON.stringify(doc));

    const reopened = await Repository.open(persistence, makeOptions(9_000_000));
    assert.deepEqual(reopened.addTask("i need celery").buckets, ["groceries"]);
  });
});

describe("Repository — tags only ever target existing buckets", () => {
  it("never auto-creates buckets, even on a clear match", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const task = repo.addTask("i need celery and onions");
    assert.deepEqual(task.buckets, []);
    assert.deepEqual(repo.listBuckets(), []);
  });

  it("ignores incidental single words in longer text", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    const task = repo.addTask("watch the onion movie trailer");
    assert.deepEqual(task.buckets, []);
  });

  it("maps concepts onto alias buckets ('Food' behaves as groceries)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Food");
    const task = repo.addTask("i need celery and onions");
    assert.deepEqual(task.buckets, ["Food"]);
    assert.deepEqual(repo.listBuckets(), ["Food"]);
  });

  it("a deleted bucket stays gone and captures stay untagged", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("groceries");
    repo.deleteBucket("groceries");
    const task = repo.addTask("i need celery and onions");
    assert.deepEqual(task.buckets, []);
    assert.deepEqual(repo.listBuckets(), []);
  });
});
