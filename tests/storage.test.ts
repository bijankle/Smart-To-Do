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
    repo.addTask("first");
    repo.addTask("second");
    repo.addTask("third");
    assert.deepEqual(repo.listTasks().map((t) => t.title), ["third", "second", "first"]);
  });

  it("moveToTop expresses importance without priority tags", async () => {
    const { repo } = await freshRepo();
    repo.addTask("first");
    const important = repo.addTask("pay the bill");
    repo.addTask("third");
    repo.moveToTop(important.id);
    assert.equal(repo.listTasks()[0]!.title, "pay the bill");
  });

  it("moveAfter reorders between neighbors", async () => {
    const { repo } = await freshRepo();
    const a = repo.addTask("a");
    const b = repo.addTask("b");
    const c = repo.addTask("c"); // list: c, b, a
    repo.moveAfter(c.id, b.id); // list: b, c, a
    assert.deepEqual(repo.listTasks().map((t) => t.id), [b.id, c.id, a.id]);
    repo.moveAfter(a.id, null); // to the very top
    assert.deepEqual(repo.listTasks().map((t) => t.id), [a.id, b.id, c.id]);
  });

  it("tombstones deletes instead of removing records", async () => {
    const { repo } = await freshRepo();
    const task = repo.addTask("temp");
    repo.deleteTask(task.id);
    assert.equal(repo.listTasks().length, 0);
    const doc = deserializeDoc(repo.exportDoc());
    assert.ok(doc.tasks[task.id]!.deletedAt !== null);
  });

  it("completed tasks vanish from listTasks and appear in listCompleted, recent-first", async () => {
    const { repo } = await freshRepo();
    const a = repo.addTask("first done");
    const b = repo.addTask("second done");
    repo.addTask("still open");
    repo.setDone(a.id, true);
    repo.setDone(b.id, true); // completed later than a

    assert.deepEqual(repo.listTasks().map((t) => t.title), ["still open"]);
    assert.deepEqual(repo.listCompleted().map((t) => t.title), ["second done", "first done"]);

    // Un-completing puts it back in the open list.
    repo.setDone(b.id, false);
    assert.equal(repo.getTask(b.id)!.completedAt, null);
    assert.ok(repo.listTasks().some((t) => t.id === b.id));
  });
});

describe("Repository — bucket origins", () => {
  it("orders user buckets before auto buckets in the pill bar", async () => {
    const { repo } = await freshRepo();
    repo.addTask("hammer and nails"); // auto-creates hardware first...
    repo.createBucket("projects"); // ...but user buckets still sort first
    assert.deepEqual(repo.listBucketDetails(), [
      { name: "projects", auto: false },
      { name: "hardware", auto: true },
    ]);
  });

  it("promotes an auto bucket to user when the user files into it", async () => {
    const { repo } = await freshRepo();
    const task = repo.addTask("hammer and nails");
    assert.equal(repo.listBucketDetails()[0]!.auto, true);
    repo.setBucket(task.id, null);
    repo.setBucket(task.id, "hardware"); // explicit user move = adoption
    assert.deepEqual(repo.listBucketDetails(), [{ name: "hardware", auto: false }]);
  });
});

describe("Repository — buckets, pills, and learning", () => {
  it("filters by pill: all, inbox, and named bucket", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Work");
    repo.addTask("untagged note");
    repo.addTask("send report", "Work");
    assert.equal(repo.listTasks("all").length, 2);
    assert.deepEqual(repo.listTasks("inbox").map((t) => t.title), ["untagged note"]);
    assert.deepEqual(repo.listTasks("Work").map((t) => t.title), ["send report"]);
  });

  it("auto-buckets new captures once the model has learned", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Groceries");
    repo.createBucket("Work");
    repo.addTask("buy milk and eggs", "Groceries");
    repo.addTask("buy bread at the store", "Groceries");
    repo.addTask("email the quarterly report", "Work");
    repo.addTask("review report deck slides", "Work");

    const auto = repo.addTask("buy eggs and bread");
    assert.equal(auto.bucket, "Groceries");
    // Auto-assignment must NOT train the model on its own prediction.
    assert.equal(auto.trainedBucket, null);
  });

  it("low-confidence captures land in the inbox", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Groceries");
    repo.addTask("buy milk", "Groceries");
    const vague = repo.addTask("zzz unrelated gibberish qqq");
    assert.equal(vague.bucket, null);
    assert.deepEqual(repo.listTasks("inbox").map((t) => t.id), [vague.id]);
  });

  it("setBucket is the correction signal: untrains old, trains new", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Errands");
    repo.createBucket("Health");
    repo.addTask("gym session", "Errands");
    const second = repo.addTask("gym cardio", "Errands");
    repo.setBucket(second.id, "Health");
    repo.setBucket(repo.listTasks("Errands")[0]!.id, "Health");

    const next = repo.addTask("gym leg day");
    assert.equal(next.bucket, "Health");
  });

  it("deleteBucket sends its tasks back to the inbox", async () => {
    const { repo } = await freshRepo();
    repo.createBucket("Temp");
    const task = repo.addTask("orphan me", "Temp");
    repo.deleteBucket("Temp");
    assert.deepEqual(repo.listBuckets(), []);
    assert.equal(repo.getTask(task.id)!.bucket, null);
    assert.equal(repo.getTask(task.id)!.trainedBucket, null);
  });
});

describe("Persistence and merge", () => {
  it("persists after mutations and reloads identically", async () => {
    const persistence = new MemoryPersistence();
    const options = makeOptions();
    const repo = await Repository.open(persistence, options);
    repo.createBucket("Work");
    repo.addTask("send report", "Work");
    await repo.flush();

    const reopened = await Repository.open(persistence, makeOptions(2_000_000));
    assert.deepEqual(reopened.listTasks("Work").map((t) => t.title), ["send report"]);
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
    repo.addTask("hello");
    await repo.flush();
    const reopened = await Repository.open(persistence, makeOptions(2_000_000));
    assert.equal(reopened.listTasks()[0]!.title, "hello");
  });

  it("mergeDocs is last-write-wins per record, tombstones included", () => {
    const base = createDoc(new Date(1000));
    const mkTask = (id: string, title: string, modifiedAt: string, deletedAt: string | null = null) => ({
      id, title, bucket: null, done: false, order: 0,
      createdAt: "2026-01-01T00:00:00.000Z", modifiedAt, deletedAt, trainedBucket: null,
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

    // Commutative up to timestamp ties.
    const mergedReverse = mergeDocs(b, a);
    assert.deepEqual(merged.tasks, mergedReverse.tasks);
  });

  it("mergeRemote folds another device's doc into a live repository", async () => {
    const optionsA = makeOptions(1_000_000, "a");
    const optionsB = makeOptions(5_000_000, "b"); // device B's clock is later
    const repoA = await Repository.open(new MemoryPersistence(), optionsA);
    const repoB = await Repository.open(new MemoryPersistence(), optionsB);
    repoA.createBucket("Work");
    repoA.addTask("from device A", "Work");
    repoB.addTask("from device B");

    repoA.mergeRemote(deserializeDoc(repoB.exportDoc()));
    const titles = repoA.listTasks().map((t) => t.title);
    assert.ok(titles.includes("from device A") && titles.includes("from device B"));
  });
});
