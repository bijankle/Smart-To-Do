/**
 * Phase 2 — The single sync-ready document.
 *
 * Everything the app knows (tasks, buckets, classifier model) lives in one
 * JSON-serializable StoreDoc. Deletions are tombstones (deletedAt) rather than
 * removals, and every record carries modifiedAt, so two divergent copies of
 * the document can always be merged deterministically with per-record
 * last-write-wins — the property Phase 4's cloud sync relies on.
 */

import type { ClassifierModel } from "../engine/classify.js";
import { createModel } from "../engine/classify.js";

export interface TaskRecord {
  id: string;
  title: string;
  /** Bucket name, or null = Inbox / untagged. */
  bucket: string | null;
  done: boolean;
  /** Manual sort position; lists render ascending, so smaller = nearer the top. */
  order: number;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
  /**
   * The bucket this task's text was last trained into, so a later re-bucketing
   * knows exactly what to untrain. Null when the task never trained the model.
   */
  trainedBucket: string | null;
}

export interface BucketRecord {
  name: string;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
}

export interface StoreDoc {
  version: 1;
  tasks: Record<string, TaskRecord>;
  buckets: Record<string, BucketRecord>;
  model: ClassifierModel;
  modelModifiedAt: string;
}

export function createDoc(now: Date = new Date()): StoreDoc {
  return {
    version: 1,
    tasks: {},
    buckets: {},
    model: createModel(),
    modelModifiedAt: now.toISOString(),
  };
}

function newerOf<T extends { modifiedAt: string }>(a: T | undefined, b: T | undefined): T {
  if (!a) return b!;
  if (!b) return a;
  return b.modifiedAt > a.modifiedAt ? b : a;
}

/**
 * Deterministic merge of two copies of the document: union of records,
 * last-write-wins per record (tombstones win like any other write), and the
 * classifier model taken wholesale from whichever side trained more recently.
 * Commutative up to timestamp ties, so sync order between devices can't
 * corrupt the store.
 */
export function mergeDocs(local: StoreDoc, remote: StoreDoc): StoreDoc {
  const tasks: Record<string, TaskRecord> = {};
  for (const id of new Set([...Object.keys(local.tasks), ...Object.keys(remote.tasks)])) {
    tasks[id] = newerOf(local.tasks[id], remote.tasks[id]);
  }
  const buckets: Record<string, BucketRecord> = {};
  for (const name of new Set([...Object.keys(local.buckets), ...Object.keys(remote.buckets)])) {
    buckets[name] = newerOf(local.buckets[name], remote.buckets[name]);
  }
  const modelFromRemote = remote.modelModifiedAt > local.modelModifiedAt;
  return {
    version: 1,
    tasks,
    buckets,
    model: modelFromRemote ? remote.model : local.model,
    modelModifiedAt: modelFromRemote ? remote.modelModifiedAt : local.modelModifiedAt,
  };
}

export function serializeDoc(doc: StoreDoc): string {
  return JSON.stringify(doc);
}

export function deserializeDoc(data: string): StoreDoc {
  const doc = JSON.parse(data) as StoreDoc;
  if (doc.version !== 1) throw new Error(`Unsupported store version: ${String(doc.version)}`);
  return doc;
}
