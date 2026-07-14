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
    assert.equal(conceptForBucketName("electronics")?.name, "electronics");
    assert.equal(conceptForBucketName("To-do")?.name, "todo"); // hyphen-joined name resolves
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
    assert.equal(conceptForBucketName("Electronics")?.name, "electronics");
    assert.equal(conceptForBucketName("jbhifi")?.name, "electronics");
    assert.equal(conceptForBucketName("Woolworths")?.name, "groceries");
    assert.equal(conceptForBucketName("Grocer")?.name, "groceries");
    assert.equal(conceptForBucketName("Chemist")?.name, "chemist");
    assert.equal(conceptForBucketName("Office")?.name, "stationery");
    assert.equal(conceptForBucketName("Ikea")?.name, "furniture");
    assert.equal(conceptForBucketName("Kmart")?.name, "homewares");
    assert.equal(conceptForBucketName("Clothing")?.name, "clothing");
    assert.equal(conceptForBucketName("Footwear")?.name, "footwear");
    assert.deepEqual(names(matchConcepts(tokenize("book a dentist appointment"))), ["todo"]);
  });

  it("multi-store products tag into every store that sells them", async () => {
    assert.deepEqual(names(matchConcepts(tokenize("condoms"))), ["chemist", "groceries"]);
    assert.deepEqual(names(matchConcepts(tokenize("bandaids and lube"))), ["chemist", "groceries"]);

    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Grocer");
    repo.createBucket("Chemist");
    const task = repo.addTask("condoms");
    assert.deepEqual([...task.buckets].sort(), ["Chemist", "Grocer"]);
    assert.deepEqual([...repo.addTask("panadol and bandaids").buckets].sort(), [
      "Chemist",
      "Grocer",
    ]);
  });

  it("two supermarkets both get grocery items", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Grocer");
    repo.createBucket("Woolworths");
    const task = repo.addTask("milk and bread");
    assert.deepEqual([...task.buckets].sort(), ["Grocer", "Woolworths"]);
  });

  it("understands brand names ('milo and glad wrap')", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Grocer");
    repo.createBucket("Bunnings");
    assert.deepEqual(repo.addTask("milo and glad wrap").buckets, ["Grocer"]);
    assert.deepEqual(repo.addTask("ryobi drill and dulux paint").buckets, ["Bunnings"]);
  });

  it("retagUntagged files stuck items once the vocabulary catches up", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const stuck = repo.addTask("bandaids"); // no buckets exist yet
    assert.deepEqual(stuck.buckets, []);
    repo.createBucket("Grocer");
    repo.createBucket("Chemist");
    repo.retagUntagged();
    assert.deepEqual([...repo.getTask(stuck.id)!.buckets].sort(), ["Chemist", "Grocer"]);
  });

  it("retagUntagged never re-adds tags the user removed", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Grocer");
    repo.createBucket("Chemist");
    const task = repo.addTask("condoms");
    repo.toggleBucket(task.id, "Grocer"); // user says: not from Grocer
    repo.toggleBucket(task.id, "Chemist"); // ...nor the chemist
    assert.deepEqual(repo.getTask(task.id)!.buckets, []);
    repo.retagUntagged();
    assert.deepEqual(repo.getTask(task.id)!.buckets, []);
  });

  it("files clothing and stationery runs into store buckets", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("uniqlo");
    repo.createBucket("Office");
    assert.deepEqual(repo.addTask("socks and a hoodie").buckets, ["uniqlo"]);
    assert.deepEqual(repo.addTask("stapler and highlighters").buckets, ["Office"]);
  });

  it("routes non-shopping tasks (admin + appointments) to a single To-do bucket", async () => {
    assert.equal(conceptForBucketName("To-do")?.name, "todo");

    // The media concepts (music/films/books) were removed with the feature.
    assert.equal(conceptForBucketName("Music"), null);
    assert.equal(conceptForBucketName("Films"), null);
    assert.equal(conceptForBucketName("Books"), null);

    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("To-do");
    repo.createBucket("Clothing");
    repo.createBucket("Footwear");
    repo.createBucket("Kmart");
    assert.deepEqual(repo.addTask("book a dentist appointment").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("physio referral for my knee").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("do my tax return on mygov").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("cancel my gym subscription").buckets, ["To-do"]);
    // Broadened: activities, admin, finance and planning are tasks, not objects.
    assert.deepEqual(repo.addTask("cooking class").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("use claude for financial planning").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("pay the electricity bill").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("book a haircut").buckets, ["To-do"]);
    // But object purchases must NOT be dragged into To-do — shoes now file
    // into their own Footwear bucket (moved out of clothing).
    assert.deepEqual(repo.addTask("running shoes").buckets, ["Footwear"]);

    // A leading chore verb makes it a task about an object, not a purchase.
    assert.deepEqual(repo.addTask("rotate the mattress").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("clean and condition leather boots").buckets, ["To-do"]);
    assert.deepEqual(repo.addTask("back up my photos and files").buckets, ["To-do"]);
    // …but the gerund form is a product, so it stays with the store.
    assert.deepEqual(repo.addTask("cleaning cloths").buckets, ["Kmart"]);
  });

  it("adds an Outdoor category and resolves descriptive product names", async () => {
    assert.equal(conceptForBucketName("Outdoor")?.name, "outdoor");
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    for (const b of ["Grocer", "Chemist", "Kmart", "Outdoor", "Office"]) {
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
    // Beauty toner → Kmart + Chemist; printer toner → Office (+ Kmart stationery).
    assert.deepEqual(repo.addTask("witch hazel toner").buckets.sort(), ["Chemist", "Kmart"]);
    assert.deepEqual(repo.addTask("printer toner cartridge").buckets.sort(), ["Kmart", "Office"]);
  });

  it("files general clothing into Kmart as well as Clothing", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    for (const b of ["Clothing", "Kmart", "Ikea"]) repo.createBucket(b);
    assert.deepEqual(repo.addTask("jacket").buckets.sort(), ["Clothing", "Kmart"]);
    assert.deepEqual(repo.addTask("socks").buckets.sort(), ["Clothing", "Kmart"]);
    // A wardrobe is furniture, not apparel — Ikea, and Kmart (also stocks furniture).
    assert.deepEqual(repo.addTask("wardrobe").buckets.sort(), ["Ikea", "Kmart"]);
    // Without a Kmart pill, clothing still just goes to Clothing.
    const solo = await Repository.open(new MemoryPersistence(), makeOptions());
    solo.createBucket("Clothing");
    assert.deepEqual(solo.addTask("jacket").buckets, ["Clothing"]);
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
    repo.createBucket("Grocer");
    repo.createBucket("Chemist");
    assert.deepEqual([...repo.addTask("tw33zer").buckets].sort(), ["Chemist", "Grocer"]);
    assert.deepEqual([...repo.addTask("tweezers for balls").buckets].sort(), [
      "Chemist",
      "Grocer",
    ]);
    // "t9ilet paper": both words resolve, and the strong groceries pair
    // (toilet + paper) suppresses the stationery reading of "paper".
    assert.deepEqual(repo.addTask("t9ilet paper").buckets, ["Grocer"]);
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

  it("store-name buckets behave as their category (Bunnings, Electronics)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("Bunnings");
    repo.createBucket("Electronics");
    assert.deepEqual(repo.addTask("screws and paint").buckets, ["Bunnings"]);
    assert.deepEqual(repo.addTask("hdmi cable and a charger").buckets, ["Electronics"]);
    const mixed = repo.addTask("drill bits and a webcam");
    assert.deepEqual([...mixed.buckets].sort(), ["Bunnings", "Electronics"]);
  });

  it("files appointment phrasing into the To-do bucket, typos included", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("To-do");
    assert.deepEqual(repo.addTask("book a dentist appointment").buckets, ["To-do"]);
    // The fuzzy layer resolves these at capture time now.
    assert.deepEqual(repo.addTask("book a dentst appointmnt").buckets, ["To-do"]);
  });

  it("renaming an untagged task re-runs auto-tagging (garbled beyond repair)", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("To-do");
    const task = repo.addTask("zxq dzntxst zppt"); // too mangled even for fuzzy
    assert.deepEqual(task.buckets, []);
    repo.renameTask(task.id, "book a dentist appointment");
    assert.deepEqual(repo.getTask(task.id)!.buckets, ["To-do"]);
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

  it("covers electronics objects and To-do computer chores", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.createBucket("electronics");
    repo.createBucket("To-do");
    assert.deepEqual(repo.addTask("hdmi cable and a phone charger").buckets, ["electronics"]);
    assert.deepEqual(repo.addTask("backup my files and cancel a subscription").buckets, ["To-do"]);
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
