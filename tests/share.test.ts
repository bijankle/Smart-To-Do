import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/storage/repo.js";
import { MemoryPersistence } from "../src/storage/persistence.js";
import {
  packShare,
  unpackShare,
  buildShareDoc,
  bytesToBase64url,
  base64urlToBytes,
} from "../src/sync/share.js";
import { deserializeDoc } from "../src/storage/doc.js";

describe("Share links", () => {
  it("round-trips arbitrary bytes through URL-safe base64", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
      const encoded = bytesToBase64url(bytes);
      assert.match(encoded, /^[A-Za-z0-9_-]*$/, "only URL-safe chars");
      assert.deepEqual([...base64urlToBytes(encoded)], [...bytes]);
    }
  });

  it("round-trips a UTF-8 payload (accents, emoji) through base64", () => {
    const text = "Café crème ☕ — naïve façade 日本語 🛒";
    const bytes = new TextEncoder().encode(text);
    assert.equal(new TextDecoder().decode(base64urlToBytes(bytesToBase64url(bytes))), text);
  });

  async function seededRepo(): Promise<Repository> {
    let tick = 0;
    const repo = await Repository.open(new MemoryPersistence(), {
      now: () => new Date(1_000_000 + ++tick * 1000),
      newId: () => `task-${tick}`,
    });
    repo.createBucket("Coles");
    repo.createBucket("Bunnings");
    repo.addTask("milk and eggs", "Coles");
    repo.addTask("box of screws", "Bunnings");
    return repo;
  }

  it("packs and unpacks a document, preserving tasks and buckets", async () => {
    const repo = await seededRepo();
    const doc = deserializeDoc(repo.exportDoc());

    const shared = unpackShare(packShare(doc));
    assert.deepEqual(
      Object.values(shared.tasks)
        .map((t) => t.title)
        .sort(),
      ["box of screws", "milk and eggs"],
    );
    assert.ok(shared.buckets["Coles"]);
    assert.ok(shared.buckets["Bunnings"]);
    // A shared copy loads cleanly as a full document.
    const loaded = await Repository.open(new MemoryPersistence());
    loaded.restoreSnapshot(packShare(doc));
    assert.equal(loaded.listTasks("Coles").length, 1);
  });

  it("drops tombstones and the trained model from the shared copy", async () => {
    const repo = await seededRepo();
    const doomed = repo.addTask("delete me");
    repo.deleteTask(doomed.id);
    const doc = deserializeDoc(repo.exportDoc());

    const shareDoc = buildShareDoc(doc);
    assert.ok(!Object.values(shareDoc.tasks).some((t) => t.title === "delete me"));
    assert.ok(!Object.values(shareDoc.tasks).some((t) => t.deletedAt));
    // Model is reset to empty (no trained token counts travel in the link).
    assert.equal(shareDoc.model.totalDocs, 0);
    assert.deepEqual(shareDoc.model.buckets, {});
  });

  it("editing a shared copy never mutates the original document", async () => {
    const repo = await seededRepo();
    const link = packShare(deserializeDoc(repo.exportDoc()));

    // The recipient opens the link into an isolated in-memory repo.
    const guest = await Repository.open(new MemoryPersistence());
    guest.restoreSnapshot(link);
    const first = guest.listTasks("Coles")[0]!;
    guest.deleteTask(first.id);
    guest.addTask("guest-only item", "Coles");

    // Original is untouched — the link carried a copy, not a reference.
    assert.equal(repo.listTasks("Coles").length, 1);
    assert.equal(repo.listTasks("Coles")[0]!.title, "milk and eggs");
    assert.ok(!repo.listTasks("Coles").some((t) => t.title === "guest-only item"));
  });
});
