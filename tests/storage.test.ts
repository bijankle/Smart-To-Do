import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repo.js";
import { MemoryPersistence, WebStoragePersistence, type StorageLike } from "../src/storage/persistence.js";
import { createDoc, deserializeDoc, mergeDocs, serializeDoc } from "../src/storage/doc.js";

/** Deterministic clock/id factory so tests never depend on wall time. */
function makeOptions(startMs = 1_000_000, device = "dev") {
  let tick = 0;
  let id = 0;
  return {
    now: () => new Date(startMs + ++tick * 1000),
    newId: () => `${device}-task-${++id}`,
  };
}

async function freshRepo() {
  const persistence = new MemoryPersistence();
  const repo = await Repository.open(persistence, makeOptions());
  return { repo, persistence };
}

describe("Repository — tasks and ordering", () => {
  it("adds new tasks to the top of the list", async () => {
    const { repo } = await freshRepo();
    repo.addTask("first zz");
    repo.addTask("second zz");
    repo.addTask("third zz");
    assert.deepEqual(repo.listTasks().map((t) => t.title), ["third zz", "second zz", "first zz"]);
  });

  it("moveToTop expresses importance without priority tags", async () => {
    const { repo } = await freshRepo();
    repo.addTask("first zz");
    const important = repo.addTask("important thing zz");
    repo.addTask("third zz");
    repo.moveToTop(important.id);
    assert.equal(repo.listTasks()[0]!.title, "important thing zz");
  });

  it("moveAfter reorders between neighbors", async () => {
    const { repo } = await freshRepo();
    const a = repo.addTask("aa zz");
    const b = repo.addTask("bb zz");
    const c = repo.addTask("cc zz"); // list: c, b, a
    repo.moveAfter(c.id, b.id); // list: b, c, a
    assert.deepEqual(repo.listTasks().map((t) => t.id), [b.id, c.id, a.id]);
    repo.moveAfter(a.id, null); // to the very top
    assert.deepEqual(repo.listTasks().map((t) => t.id), [a.id, b.id, c.id]);
  });

  it("tombstones deletes instead of removing records", async () => {
    const { repo } = await freshRepo();
    const task = repo.addTask("temp zz");
    repo.deleteTask(task.id);
    assert.equal(repo.listTasks().length, 0);
    const doc = deserializeDoc(repo.exportDoc());
    assert.ok(doc.tasks[task.id]!.deletedAt !== null);
  });

  it("completed tasks vanish from listTasks and appear in listCompleted, recent-first", async () => {
    const { repo } = await freshRepo();
    const a = repo.addTask("first done zz");
    const b = repo.addTask("second done zz");
    repo.addTask("still open zz");
    repo.setDone(a.id, true);
    repo.setDone(b.id, true); // completed later than a

    assert.deepEqual(repo.listTasks().map((t) => t.title), ["still open zz"]);
    assert.deepEqual(repo.listCompleted().map((t) => t.title), ["second done zz", "first done zz"]);

    repo.setDone(b.id, false);
    assert.equal(repo.getTask(b.id)!.completedAt, null);
    assert.ok(repo.listTasks().some((t) => t.id === b.id));
  });
});

describe("Repository — buckets, pills, and learning", () => {
  it("filters by pill: all and named bucket; untagged shows only in All", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Work");
    const untagged = repo.addTask("mystery zz");
    repo.addTask("send the report", "Work");
    assert.equal(repo.listTasks("all").length, 2);
    assert.deepEqual(repo.listTasks("Work").map((t) => t.title), ["send the report"]);
    assert.deepEqual(untagged.buckets, []);
  });

  it("auto-buckets new captures once the model has learned", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Snacks");
    repo.createBucket("Work");
    repo.addTask("crisps and dip zz", "Snacks");
    repo.addTask("popcorn refill zz", "Snacks");
    repo.addTask("email the quarterly report", "Work");
    repo.addTask("review report deck slides", "Work");

    const auto = repo.addTask("email the report");
    assert.deepEqual(auto.buckets, ["Work"]);
    // Auto-assignment must NOT train the model on its own prediction.
    assert.deepEqual(auto.trainedBuckets, []);
  });

  it("unclear captures stay untagged (visible in All only)", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("groceries");
    const vague = repo.addTask("zzz unrelated gibberish qqq");
    assert.deepEqual(vague.buckets, []);
    assert.ok(repo.listTasks("all").some((t) => t.id === vague.id));
    assert.equal(repo.listTasks("groceries").length, 0);
  });

  it("toggleBucket corrections retrain the classifier", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Errands");
    repo.createBucket("Zone");
    const first = repo.addTask("gymzz session leg day", "Errands");
    const second = repo.addTask("gymzz cardio", "Errands");

    for (const task of [first, second]) {
      repo.toggleBucket(task.id, "Errands"); // remove (untrain)
      repo.toggleBucket(task.id, "Zone"); // add (train)
    }
    const next = repo.addTask("gymzz leg day");
    assert.deepEqual(next.buckets, ["Zone"]);
  });

  it("deleteBucket strips the membership but keeps others", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Temp");
    repo.createBucket("Keep");
    const task = repo.addTask("orphan me zz", "Temp");
    repo.toggleBucket(task.id, "Keep");
    repo.deleteBucket("Temp");
    assert.deepEqual(repo.listBuckets(), ["Keep"]);
    assert.deepEqual(repo.getTask(task.id)!.buckets, ["Keep"]);
    assert.deepEqual(repo.getTask(task.id)!.trainedBuckets, ["Keep"]);
  });
});

describe("Repository — bucket origins (legacy auto buckets)", () => {
  it("orders user buckets before auto buckets in the pill bar", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("hardware", "auto"); // e.g. created by an older version
    repo.createBucket("projects");
    assert.deepEqual(repo.listBucketDetails(), [
      { name: "projects", auto: false },
      { name: "hardware", auto: true },
    ]);
  });

  it("promotes an auto bucket to user when the user files into it", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("hardware", "auto");
    const task = repo.addTask("hammer and nails");
    assert.deepEqual(task.buckets, ["hardware"]);
    assert.equal(repo.listBucketDetails()[0]!.auto, true);
    repo.toggleBucket(task.id, "hardware"); // remove — not an adoption
    assert.equal(repo.listBucketDetails()[0]!.auto, true);
    repo.toggleBucket(task.id, "hardware"); // explicit add = adoption
    assert.deepEqual(repo.listBucketDetails(), [{ name: "hardware", auto: false }]);
  });
});

describe("Repository — bespoke store setup", () => {
  const STORES = [
    "Coles", "Bunnings", "Chemist Warehouse", "JB Hi-Fi",
    "Officeworks", "Ikea", "Kmart", "Uniqlo",
  ];
  const REMAP = { groceries: "Coles", hardware: "Bunnings", electronics: "JB Hi-Fi" };

  it("creates the store pills once and migrates generic buckets", async () => {
    const persistence = new MemoryPersistence();
    const before = await Repository.open(persistence, makeOptions());
    before.createBucket("groceries");
    const onions = before.addTask("onions", "groceries");
    await before.flush();

    const repo = await Repository.open(persistence, makeOptions(2_000_000));
    assert.equal(repo.applyStoreSetup(STORES, REMAP), true);
    assert.deepEqual([...repo.listBuckets()].sort(), [...STORES].sort());
    assert.deepEqual(repo.getTask(onions.id)!.buckets, ["Coles"]);
    assert.deepEqual(repo.getTask(onions.id)!.trainedBuckets, ["Coles"]);
    // Idempotent: recorded in the doc, never runs twice.
    assert.equal(repo.applyStoreSetup(STORES, REMAP), false);
  });

  it("setup migration rebuilds the classifier, re-tags stale auto tags, and drops the media feature", async () => {
    const persistence = new MemoryPersistence();
    const before = await Repository.open(persistence, makeOptions());
    before.applyStoreSetup([...STORES, "Medical", "Chemist Warehouse"], REMAP);
    await before.flush();

    // Simulate the pre-split world: 'Medical appointment' auto-tagged into
    // Chemist Warehouse, with the doc still at setup v2.
    const doc = JSON.parse((await persistence.load())!);
    const ts = "2026-01-01T00:00:00.000Z";
    doc.tasks["stale"] = {
      id: "stale", title: "Medical appointment", buckets: ["Chemist Warehouse"],
      done: false, completedAt: null, order: 0, createdAt: ts, modifiedAt: ts,
      deletedAt: null, trainedBuckets: [],
    };
    // A media task (only bucket was Films) is removed with the feature.
    doc.tasks["film"] = {
      id: "film", title: "the matrix", buckets: ["Films"], done: false,
      completedAt: null, order: 1, createdAt: ts, modifiedAt: ts,
      deletedAt: null, trainedBuckets: [], link: "https://www.imdb.com/title/tt0133093/",
    };
    // A grocery task that also happens to sit in Music keeps its real bucket.
    doc.tasks["mixed"] = {
      id: "mixed", title: "milk", buckets: ["Coles", "Music"], done: false,
      completedAt: null, order: 2, createdAt: ts, modifiedAt: ts,
      deletedAt: null, trainedBuckets: [],
    };
    doc.buckets["Films"] = { name: "Films", createdAt: ts, modifiedAt: ts, deletedAt: null };
    doc.buckets["Music"] = { name: "Music", createdAt: ts, modifiedAt: ts, deletedAt: null };
    doc.setupVersion = 2;
    await persistence.save(JSON.stringify(doc));

    const repo = await Repository.open(persistence, makeOptions(9_000_000));
    assert.equal(repo.applyStoreSetup([...STORES, "Medical", "Chemist Warehouse"], REMAP), true);
    assert.deepEqual(repo.getTask("stale")!.buckets, ["Medical"]);
    // The media pills are gone and the media-only task with it.
    assert.equal(repo.getTask("film"), null);
    assert.ok(!repo.listBuckets().includes("Films"));
    assert.ok(!repo.listBuckets().includes("Music"));
    // The mixed task survives, minus the media membership.
    assert.deepEqual(repo.getTask("mixed")!.buckets, ["Coles"]);
    assert.equal(repo.applyStoreSetup([...STORES, "Medical", "Chemist Warehouse"], REMAP), false);
  });

  it("does not recreate a store the user deleted", async () => {
    const persistence = new MemoryPersistence();
    const repo = await Repository.open(persistence, makeOptions());
    repo.applyStoreSetup(STORES, REMAP);
    repo.deleteBucket("Uniqlo");
    await repo.flush();

    const reopened = await Repository.open(persistence, makeOptions(2_000_000));
    assert.equal(reopened.applyStoreSetup(STORES, REMAP), false);
    assert.ok(!reopened.listBuckets().includes("Uniqlo"));
  });

  it("renames the Computer pill to 'Computer tasks', keeping its tasks", async () => {
    const persistence = new MemoryPersistence();
    // Simulate an existing install (setup v4) that still has the old "Computer" pill.
    const before = await Repository.open(persistence, makeOptions());
    before.createBucket("Computer");
    const t = before.addTask("do my tax return on mygov", "Computer");
    assert.deepEqual(before.getTask(t.id)!.buckets, ["Computer"]);
    await before.flush();
    const doc = JSON.parse((await persistence.load())!);
    doc.setupVersion = 4;
    await persistence.save(JSON.stringify(doc));

    const repo = await Repository.open(persistence, makeOptions(5_000_000));
    assert.equal(repo.applyStoreSetup([...STORES, "Computer tasks"], REMAP), true);
    assert.ok(!repo.listBuckets().includes("Computer"));
    assert.ok(repo.listBuckets().includes("Computer tasks"));
    assert.deepEqual(repo.getTask(t.id)!.buckets, ["Computer tasks"]);
    // The moved training still classifies into the renamed bucket.
    assert.deepEqual(repo.addTask("backup photos and update drivers").buckets, ["Computer tasks"]);
  });

  it("clear all removes a bucket's items but keeps ones shared with another store", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.applyStoreSetup(STORES, REMAP);
    const milk = repo.addTask("milk", "Coles"); // Coles only
    const shared = repo.addTask("condoms"); // Coles AND Chemist Warehouse
    assert.ok(shared.buckets.includes("Coles") && shared.buckets.includes("Chemist Warehouse"));

    const cleared = repo.clearFilter("Coles");
    assert.equal(cleared, 2);
    assert.equal(repo.getTask(milk.id), null); // single-bucket item deleted
    assert.deepEqual(repo.getTask(shared.id)!.buckets, ["Chemist Warehouse"]); // survives elsewhere
    // Learning is preserved: a fresh "milk" still auto-tags into Coles.
    assert.deepEqual(repo.addTask("milk").buckets, ["Coles"]);
  });

  it("clear all in the All view deletes every open task", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.applyStoreSetup(STORES, REMAP);
    repo.addTask("milk");
    repo.addTask("hammer");
    const done = repo.addTask("bananas");
    repo.setDone(done.id, true); // completed tasks are untouched by clear
    assert.equal(repo.clearFilter("all"), 2);
    assert.equal(repo.listTasks("all").length, 0);
    assert.equal(repo.listCompleted("all").length, 1);
  });

  it("strips Markdown table pipes from existing task titles", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    const t = repo.addTask("| Camping hammock |");
    const clean = repo.addTask("Water bottle");
    assert.equal(repo.stripTitleFormatting(), 1); // only the piped one changes
    assert.equal(repo.getTask(t.id)!.title, "Camping hammock");
    assert.equal(repo.getTask(clean.id)!.title, "Water bottle");
    assert.equal(repo.stripTitleFormatting(), 0); // idempotent
  });

  it("auto-tags everyday captures into the right store", async () => {
    const repo = await Repository.open(new MemoryPersistence(), makeOptions());
    repo.applyStoreSetup(STORES, REMAP);
    assert.deepEqual(repo.addTask("milk and bread").buckets, ["Coles"]);
    assert.deepEqual(repo.addTask("drill bits").buckets, ["Bunnings"]);
    assert.deepEqual(repo.addTask("prescription refill").buckets, ["Chemist Warehouse"]);
    assert.deepEqual(repo.addTask("hdmi cable").buckets, ["JB Hi-Fi"]);
    assert.deepEqual(repo.addTask("stapler and paper").buckets, ["Officeworks"]);
    assert.deepEqual(repo.addTask("bookshelf and cushions").buckets, ["Ikea"]);
    assert.deepEqual(repo.addTask("storage tubs and hangers").buckets, ["Kmart"]);
    assert.deepEqual(repo.addTask("socks and jeans").buckets, ["Uniqlo"]);
  });
});

describe("Persistence and merge", () => {
  it("persists after mutations and reloads identically", async () => {
    const persistence = new MemoryPersistence();
    const repo = await Repository.open(persistence, makeOptions());
    repo.createBucket("Work");
    repo.addTask("send the report", "Work");
    await repo.flush();

    const reopened = await Repository.open(persistence, makeOptions(2_000_000));
    assert.deepEqual(reopened.listTasks("Work").map((t) => t.title), ["send the report"]);
    assert.deepEqual(reopened.listBuckets(), ["Work"]);
  });

  it("WebStoragePersistence round-trips through a Storage-like backend", async () => {
    const backing = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => backing.get(k) ?? null,
      setItem: (k, v) => void backing.set(k, v),
    };
    const persistence = new WebStoragePersistence(storage);
    const repo = await Repository.open(persistence, makeOptions());
    repo.addTask("hello zz");
    await repo.flush();
    const reopened = await Repository.open(persistence, makeOptions(2_000_000));
    assert.equal(reopened.listTasks()[0]!.title, "hello zz");
  });

  it("migrates legacy single-bucket records on load", async () => {
    const persistence = new MemoryPersistence();
    const ts = "2026-01-01T00:00:00.000Z";
    const legacy = {
      version: 1,
      tasks: {
        t1: {
          id: "t1", title: "old task", bucket: "Work", done: false, order: 0,
          createdAt: ts, modifiedAt: ts, deletedAt: null, trainedBucket: "Work",
        },
        t2: {
          id: "t2", title: "old untagged", bucket: null, done: false, order: 1,
          createdAt: ts, modifiedAt: ts, deletedAt: null, trainedBucket: null,
        },
      },
      buckets: { Work: { name: "Work", createdAt: ts, modifiedAt: ts, deletedAt: null } },
      model: { version: 1, totalDocs: 0, buckets: {} },
      modelModifiedAt: ts,
    };
    await persistence.save(JSON.stringify(legacy));

    const repo = await Repository.open(persistence, makeOptions());
    assert.deepEqual(repo.getTask("t1")!.buckets, ["Work"]);
    assert.deepEqual(repo.getTask("t1")!.trainedBuckets, ["Work"]);
    assert.deepEqual(repo.getTask("t2")!.buckets, []);
    assert.deepEqual(repo.listTasks("Work").map((t) => t.id), ["t1"]);
  });

  it("mergeDocs is last-write-wins per record, tombstones included", () => {
    const base = createDoc(new Date(1000));
    const mkTask = (id: string, title: string, modifiedAt: string, deletedAt: string | null = null) => ({
      id, title, buckets: [] as string[], done: false, completedAt: null, order: 0,
      createdAt: "2026-01-01T00:00:00.000Z", modifiedAt, deletedAt, trainedBuckets: [] as string[],
    });

    const a = deserializeDoc(serializeDoc(base));
    const b = deserializeDoc(serializeDoc(base));
    a.tasks["t1"] = mkTask("t1", "edited on A", "2026-01-02T00:00:00.000Z");
    b.tasks["t1"] = mkTask("t1", "edited on B later", "2026-01-03T00:00:00.000Z");
    a.tasks["t2"] = mkTask("t2", "only on A", "2026-01-02T00:00:00.000Z");
    b.tasks["t3"] = mkTask("t3", "deleted on B", "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z");

    const merged = mergeDocs(a, b);
    assert.equal(merged.tasks["t1"]!.title, "edited on B later");
    assert.equal(merged.tasks["t2"]!.title, "only on A");
    assert.ok(merged.tasks["t3"]!.deletedAt !== null);

    const mergedReverse = mergeDocs(b, a);
    assert.deepEqual(merged.tasks, mergedReverse.tasks);
  });

  it("mergeRemote folds another device's doc into a live repository", async () => {
    const repoA = await Repository.open(new MemoryPersistence(), makeOptions(1_000_000, "a"));
    const repoB = await Repository.open(new MemoryPersistence(), makeOptions(5_000_000, "b"));
    repoA.createBucket("Work");
    repoA.addTask("from device A", "Work");
    repoB.addTask("from device B zz");

    repoA.mergeRemote(deserializeDoc(repoB.exportDoc()));
    const titles = repoA.listTasks().map((t) => t.title);
    assert.ok(titles.includes("from device A") && titles.includes("from device B zz"));
  });
});
