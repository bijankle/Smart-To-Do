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
  /**
   * Bucket memberships — one task can live in several buckets at once
   * ("onions and a hammer" → groceries AND hardware) and is the same record
   * everywhere, so completing it anywhere completes it everywhere.
   * Empty = untagged (visible only in All).
   */
  buckets: string[];
  done: boolean;
  /** When the task was checked off; completed lists sort most-recent-first. */
  completedAt?: string | null;
  /** Manual sort position; lists render ascending, so smaller = nearer the top. */
  order: number;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
  /**
   * Buckets this task's text has been trained into, so a later re-tagging
   * knows exactly what to untrain.
   */
  trainedBuckets: string[];
  /**
   * True once the user has hand-adjusted this task's tags — automatic
   * re-tagging then leaves it alone (a removed tag must never come back).
   */
  manualTags?: boolean;
  /** Source URL for tasks created from a pasted link (Goodreads/IMDb). */
  link?: string;
  /** Key info shown in the title callout, e.g. { Author, Published, Pages }. */
  info?: Record<string, string>;
}

export interface BucketRecord {
  name: string;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
  /** True once the bucket has been pre-trained from the seed lexicon. */
  seeded?: boolean;
  /**
   * "auto" = created by the lexicon matcher; "user" (or absent, for legacy
   * records) = created or adopted by the user. Auto buckets render with a
   * subtle visual difference and sort after user buckets; they promote to
   * "user" the first time the user files a task into them.
   */
  origin?: "user" | "auto";
}

export interface StoreDoc {
  version: 1;
  tasks: Record<string, TaskRecord>;
  buckets: Record<string, BucketRecord>;
  model: ClassifierModel;
  modelModifiedAt: string;
  /** Highest one-time setup migration applied (e.g. bespoke store pills). */
  setupVersion?: number;
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
    setupVersion: Math.max(local.setupVersion ?? 0, remote.setupVersion ?? 0),
  };
}

export function serializeDoc(doc: StoreDoc): string {
  return JSON.stringify(doc);
}

/** Fields from earlier schema revisions, normalized away on load. */
interface LegacyTaskFields {
  bucket?: string | null;
  trainedBucket?: string | null;
  childIds?: string[];
  parentId?: string;
}

export function deserializeDoc(data: string): StoreDoc {
  const doc = JSON.parse(data) as StoreDoc;
  if (doc.version !== 1) throw new Error(`Unsupported store version: ${String(doc.version)}`);
  // Migrate records written before multi-bucket membership existed.
  for (const task of Object.values(doc.tasks) as Array<TaskRecord & LegacyTaskFields>) {
    if (!Array.isArray(task.buckets)) task.buckets = task.bucket ? [task.bucket] : [];
    if (!Array.isArray(task.trainedBuckets)) {
      task.trainedBuckets = task.trainedBucket ? [task.trainedBucket] : [];
    }
    delete task.bucket;
    delete task.trainedBucket;
    delete task.childIds;
    delete task.parentId;
  }
  return doc;
}
