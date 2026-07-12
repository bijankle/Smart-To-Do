import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conceptForBucketName, matchConcepts } from "../src/engine/lexicon.js";
import { correctToken, editDistance, tokenize } from "../src/engine/tokenize.js";
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
    assert.equal(conceptForBucketName("Chemist Warehouse")?.name, "chemist");
    assert.equal(conceptForBucketName("Officeworks")?.name, "stationery");
    assert.equal(conceptForBucketName("Ikea")?.name, "furniture");
    assert.equal(conceptForBucketName("Kmart")?.name, "homewares");
    assert.equal(conceptForBucketName("Uniqlo")?.name, "clothing");
    assert.deepEqual(names(matchConcepts(tokenize("get a medical assessment"))), ["health"]);
  });

  it("multi-store products tag into every store that sells them", async () => {
    assert.deepEqual(names(matchConcepts(tokenize("condoms"))), ["chemist", "groceries"]);
    assert.deepEqual(names(matchConcepts(tokenize("bandaids and lube"))), ["chemist", "groceries"]);

    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Coles");
    repo.createBucket("Chemist Warehouse");
    const task = repo.addTask("condoms");
    assert.deepEqual([...task.buckets].sort(), ["Chemist Warehouse", "Coles"]);
    assert.deepEqual([...repo.addTask("panadol and bandaids").buckets].sort(), [
      "Chemist Warehouse",
      "Coles",
    ]);
  });

  it("two supermarkets both get grocery items", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Coles");
    repo.createBucket("Woolworths");
    const task = repo.addTask("milk and bread");
    assert.deepEqual([...task.buckets].sort(), ["Coles", "Woolworths"]);
  });

  it("understands brand names ('milo and glad wrap')", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Coles");
    repo.createBucket("Bunnings");
    assert.deepEqual(repo.addTask("milo and glad wrap").buckets, ["Coles"]);
    assert.deepEqual(repo.addTask("ryobi drill and dulux paint").buckets, ["Bunnings"]);
  });

  it("retagUntagged files stuck items once the vocabulary catches up", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const stuck = repo.addTask("bandaids"); // no buckets exist yet
    assert.deepEqual(stuck.buckets, []);
    repo.createBucket("Coles");
    repo.createBucket("Chemist Warehouse");
    repo.retagUntagged();
    assert.deepEqual([...repo.getTask(stuck.id)!.buckets].sort(), ["Chemist Warehouse", "Coles"]);
  });

  it("retagUntagged never re-adds tags the user removed", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Coles");
    repo.createBucket("Chemist Warehouse");
    const task = repo.addTask("condoms");
    repo.toggleBucket(task.id, "Coles"); // user says: not from Coles
    repo.toggleBucket(task.id, "Chemist Warehouse"); // ...nor the chemist
    assert.deepEqual(repo.getTask(task.id)!.buckets, []);
    repo.retagUntagged();
    assert.deepEqual(repo.getTask(task.id)!.buckets, []);
  });

  it("files clothing and stationery runs into store buckets", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("uniqlo");
    repo.createBucket("Officeworks");
    assert.deepEqual(repo.addTask("socks and a hoodie").buckets, ["uniqlo"]);
    assert.deepEqual(repo.addTask("stapler and highlighters").buckets, ["Officeworks"]);
  });

  it("covers the life categories: medical, computer", async () => {
    assert.equal(conceptForBucketName("Computer")?.name, "computer");

    // The media concepts (music/films/books) were removed with the feature.
    assert.equal(conceptForBucketName("Music"), null);
    assert.equal(conceptForBucketName("Films"), null);
    assert.equal(conceptForBucketName("Books"), null);

    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    for (const b of ["Medical", "Computer"]) repo.createBucket(b);
    assert.deepEqual(repo.addTask("book a dentist appointment").buckets, ["Medical"]);
    assert.deepEqual(repo.addTask("physio referral for my knee").buckets, ["Medical"]);
    assert.deepEqual(repo.addTask("do my tax return on mygov").buckets, ["Computer"]);
    assert.deepEqual(repo.addTask("backup photos and update drivers").buckets, ["Computer"]);
  });

  it("adds an Outdoor category and keeps fitness gear out of Medical", async () => {
    assert.equal(conceptForBucketName("Outdoor")?.name, "outdoor");
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    for (const b of ["Coles", "Chemist Warehouse", "Kmart", "Outdoor", "Medical", "Officeworks"]) {
      repo.createBucket(b);
    }
    // Descriptive filler ("non-slip", "1000-piece", "set") no longer suppresses
    // the real product noun.
    assert.deepEqual(repo.addTask("yoga mat (non-slip)").buckets, ["Kmart"]);
    assert.deepEqual(repo.addTask("1000-piece jigsaw puzzle").buckets, ["Kmart"]);
    assert.deepEqual(repo.addTask("resistance bands set").buckets, ["Kmart"]);
    // Outdoor gear routes to the new pill.
    assert.deepEqual(repo.addTask("camping hammock").buckets, ["Outdoor"]);
    assert.deepEqual(repo.addTask("kayak paddle").buckets, ["Outdoor"]);
    // Beauty toner → Kmart + Chemist (and printer toner still Officeworks).
    assert.deepEqual(repo.addTask("witch hazel toner").buckets.sort(), ["Chemist Warehouse", "Kmart"]);
    assert.deepEqual(repo.addTask("printer toner cartridge").buckets, ["Officeworks"]);
  });

  it("files general clothing into Kmart as well as Uniqlo", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    for (const b of ["Uniqlo", "Kmart", "Ikea"]) repo.createBucket(b);
    assert.deepEqual(repo.addTask("jacket").buckets.sort(), ["Kmart", "Uniqlo"]);
    assert.deepEqual(repo.addTask("socks").buckets.sort(), ["Kmart", "Uniqlo"]);
    // A wardrobe is furniture, not apparel.
    assert.deepEqual(repo.addTask("wardrobe").buckets, ["Ikea"]);
    // Without a Kmart pill, clothing still just goes to Uniqlo.
    const solo = await Repository.open(new MemoryPersistence(), makeOptions());
    solo.createBucket("Uniqlo");
    assert.deepEqual(solo.addTask("jacket").buckets, ["Uniqlo"]);
  });

  it("matches a decisive single word ('laptop')", () => {
    assert.deepEqual(names(matchConcepts(tokenize("laptop"))), ["electronics"]);
  });

  it("stays quiet on incidental single words in longer text", () => {
    assert.deepEqual(matchConcepts(tokenize("onion joke for the wedding speech")), []);
    assert.deepEqual(matchConcepts(tokenize("celery something unrelated")), []);
    assert.deepEqual(matchConcepts(tokenize("random musings about clouds")), []);
  });
});

describe("Typo failsafe", () => {
  it("editDistance handles substitutions, indels, and transpositions", () => {
    assert.equal(editDistance("onion", "onion", 2), 0);
    assert.equal(editDistance("onoin", "onion", 2), 1); // transposition
    assert.equal(editDistance("onien", "onion", 2), 1); // substitution
    assert.equal(editDistance("onon", "onion", 2), 1); // deletion
    assert.equal(editDistance("zzz", "onion", 1), 2); // early exit at max+1
  });

  it("correctToken fixes digit stand-ins and near-misses, but not short words", () => {
    const vocab = new Set(["tweezer", "toilet", "onion", "balm"]);
    assert.equal(correctToken("tw33zer", vocab), "tweezer");
    assert.equal(correctToken("t9ilet", vocab), "toilet");
    assert.equal(correctToken("onoin", vocab), "onion");
    assert.equal(correctToken("ball", vocab), null); // 4 letters: exact only
    assert.equal(correctToken("qqqqqq", vocab), null);
  });

  it("captures with typos still file correctly", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Coles");
    repo.createBucket("Chemist Warehouse");
    assert.deepEqual([...repo.addTask("tw33zer").buckets].sort(), ["Chemist Warehouse", "Coles"]);
    assert.deepEqual([...repo.addTask("tweezers for balls").buckets].sort(), [
      "Chemist Warehouse",
      "Coles",
    ]);
    // "t9ilet paper": both words resolve, and the strong groceries pair
    // (toilet + paper) suppresses the stationery reading of "paper".
    assert.deepEqual(repo.addTask("t9ilet paper").buckets, ["Coles"]);
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

  it("files medical phrasing into a medical bucket, typos included", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("medical");
    assert.deepEqual(repo.addTask("get a medical assessment").buckets, ["medical"]);
    // The fuzzy layer resolves these at capture time now.
    assert.deepEqual(repo.addTask("get a medcical asessment").buckets, ["medical"]);
  });

  it("renaming an untagged task re-runs auto-tagging (garbled beyond repair)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("medical");
    const task = repo.addTask("get a mzdxcal asmt"); // too mangled even for fuzzy
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
    const task = repo.addTask("onion joke for the wedding speech");
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
