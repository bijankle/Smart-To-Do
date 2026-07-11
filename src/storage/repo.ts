/**
 * Phase 2 — Repository: the single API surface the UI talks to.
 *
 * Responsibilities:
 *  - Task CRUD with tombstone deletes and manual ordering (new tasks and
 *    "move to top" go to the head of the list — importance is expressed by
 *    position, not priority tags).
 *  - Auto-bucketing on capture via the Naive Bayes classifier; the model is
 *    trained ONLY by explicit user actions (assigning or moving a task to a
 *    bucket), never by its own predictions, so it can't drift on its own.
 *  - Persistence after every mutation through the injected adapter.
 */

import { classify, ensureBucket, seed, train, untrain } from "../engine/classify.js";
import { conceptForBucketName, matchConcept, type Concept } from "../engine/lexicon.js";
import { stem, tokenize } from "../engine/tokenize.js";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../engine/parse.js";
import {
  createDoc,
  deserializeDoc,
  mergeDocs,
  serializeDoc,
  type StoreDoc,
  type TaskRecord,
} from "./doc.js";
import type { Persistence } from "./persistence.js";

export interface RepositoryOptions {
  now?: () => Date;
  newId?: () => string;
  confidenceThreshold?: number;
}

/** Pill-bar filter: 'all', 'inbox' (untagged), or a bucket name. */
export type TaskFilter = "all" | "inbox" | string;

export class Repository {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly threshold: number;
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(
    private doc: StoreDoc,
    private readonly persistence: Persistence,
    options: RepositoryOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  static async open(persistence: Persistence, options: RepositoryOptions = {}): Promise<Repository> {
    const raw = await persistence.load();
    const doc = raw ? deserializeDoc(raw) : createDoc(options.now?.() ?? new Date());
    const repo = new Repository(doc, persistence, options);
    repo.seedUnseededBuckets();
    return repo;
  }

  /**
   * Pre-train any live bucket whose name matches a seed-lexicon concept and
   * hasn't been seeded yet. Runs on every open, so buckets created before
   * the lexicon existed (or on another device) pick up their seeds too.
   */
  private seedUnseededBuckets(): void {
    let changed = false;
    for (const bucket of Object.values(this.doc.buckets)) {
      if (bucket.deletedAt !== null || bucket.seeded) continue;
      const concept = conceptForBucketName(bucket.name);
      if (!concept) continue;
      seed(this.doc.model, bucket.name, concept.vocabulary);
      bucket.seeded = true;
      bucket.modifiedAt = this.now().toISOString();
      changed = true;
    }
    if (changed) {
      this.doc.modelModifiedAt = this.now().toISOString();
      this.scheduleSave();
    }
  }

  // ---- tasks -------------------------------------------------------------

  /**
   * Capture a task. With an explicit bucket the classifier is trained on it;
   * otherwise the classifier suggests one (below the confidence threshold the
   * task lands untagged, i.e. in the Inbox). New tasks enter at the top.
   */
  addTask(title: string, bucket?: string): TaskRecord {
    const trimmed = title.trim();
    const ts = this.now().toISOString();
    let assigned: string | null = null;
    let trainedBucket: string | null = null;

    if (bucket !== undefined) {
      this.requireBucket(bucket);
      assigned = bucket;
      train(this.doc.model, bucket, trimmed);
      this.doc.modelModifiedAt = ts;
      trainedBucket = bucket;
      this.promoteBucket(bucket);
    } else {
      const suggestion = classify(this.doc.model, trimmed);
      if (suggestion && suggestion.confidence >= this.threshold && this.isLiveBucket(suggestion.bucket)) {
        assigned = suggestion.bucket;
      } else {
        assigned = this.assignByLexicon(trimmed);
      }
      // List captures split into per-item children filed in the bucket,
      // with the original text kept as an untagged parent in "All".
      if (assigned !== null) {
        const items = this.splitListItems(trimmed, assigned);
        if (items) return this.addSplitTasks(trimmed, items, assigned, ts);
      }
    }

    const task: TaskRecord = {
      id: this.newId(),
      title: trimmed,
      bucket: assigned,
      done: false,
      completedAt: null,
      order: this.topOrder(),
      createdAt: ts,
      modifiedAt: ts,
      deletedAt: null,
      trainedBucket,
    };
    this.doc.tasks[task.id] = task;
    this.scheduleSave();
    return task;
  }

  /** Live, OPEN tasks for a pill filter, sorted top-first. Completed tasks vanish from here. */
  listTasks(filter: TaskFilter = "all"): TaskRecord[] {
    return Object.values(this.doc.tasks)
      .filter((t) => t.deletedAt === null && !t.done)
      .filter((t) => this.matchesFilter(t, filter))
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  }

  /** Live, completed tasks for a pill filter, most recently completed first. */
  listCompleted(filter: TaskFilter = "all"): TaskRecord[] {
    return Object.values(this.doc.tasks)
      .filter((t) => t.deletedAt === null && t.done)
      .filter((t) => this.matchesFilter(t, filter))
      .sort((a, b) =>
        (b.completedAt ?? b.modifiedAt).localeCompare(a.completedAt ?? a.modifiedAt),
      );
  }

  private matchesFilter(task: TaskRecord, filter: TaskFilter): boolean {
    if (filter === "all") return true;
    if (filter === "inbox") {
      // A parent whose items are filed in a bucket is not "untriaged".
      return task.bucket === null && !(task.childIds && task.childIds.length > 0);
    }
    return task.bucket === filter;
  }

  /**
   * Split a list-style capture ("i need celery and onions") into one child
   * title per segment, using the bucket's concept vocabulary. Only splits
   * when there are 2+ segments and EVERY segment contains a recognized item —
   * otherwise the capture stays a single task ("mac and cheese" doesn't split).
   */
  private splitListItems(title: string, bucket: string): string[] | null {
    const concept = conceptForBucketName(bucket);
    if (!concept) return null;
    const vocab = new Set(concept.vocabulary);
    const segments = title.split(/,|\band\b|&/i).map((s) => s.trim()).filter(Boolean);
    if (segments.length < 2) return null;

    const items: string[] = [];
    for (const segment of segments) {
      const matched = segment
        .split(/\s+/)
        .filter((word) => vocab.has(stem(word.toLowerCase().replace(/[^a-z0-9]/g, ""))));
      if (matched.length === 0) return null;
      items.push(matched.join(" "));
    }
    return items;
  }

  private addSplitTasks(fullTitle: string, items: string[], bucket: string, ts: string): TaskRecord {
    const parent: TaskRecord = {
      id: this.newId(),
      title: fullTitle,
      bucket: null,
      done: false,
      completedAt: null,
      order: this.topOrder(),
      createdAt: ts,
      modifiedAt: ts,
      deletedAt: null,
      trainedBucket: null,
      childIds: [],
    };
    this.doc.tasks[parent.id] = parent;

    // Insert in reverse so the first item ends up highest in the list.
    for (const item of [...items].reverse()) {
      const child: TaskRecord = {
        id: this.newId(),
        title: item,
        bucket,
        done: false,
        completedAt: null,
        order: this.topOrder(),
        createdAt: ts,
        modifiedAt: ts,
        deletedAt: null,
        trainedBucket: null,
        parentId: parent.id,
      };
      this.doc.tasks[child.id] = child;
      parent.childIds!.unshift(child.id);
    }
    this.scheduleSave();
    return parent;
  }

  getTask(id: string): TaskRecord | null {
    const task = this.doc.tasks[id];
    return task && task.deletedAt === null ? task : null;
  }

  /** Completing a parent completes its children (and un-completing restores them). */
  setDone(id: string, done: boolean): void {
    const task = this.requireTask(id);
    const ts = this.now().toISOString();
    const apply = (t: TaskRecord) => {
      t.done = done;
      t.completedAt = done ? ts : null;
      t.modifiedAt = ts;
    };
    apply(task);
    for (const childId of task.childIds ?? []) {
      const child = this.doc.tasks[childId];
      if (child && child.deletedAt === null) apply(child);
    }
    this.scheduleSave();
  }

  renameTask(id: string, title: string): void {
    const task = this.requireTask(id);
    // Re-point any training at the new wording so untrain stays symmetric.
    if (task.trainedBucket !== null) {
      untrain(this.doc.model, task.trainedBucket, task.title);
      train(this.doc.model, task.trainedBucket, title.trim());
      this.doc.modelModifiedAt = this.now().toISOString();
    }
    task.title = title.trim();
    this.touch(task);
  }

  deleteTask(id: string): void {
    const task = this.requireTask(id);
    task.deletedAt = this.now().toISOString();
    this.touch(task);
  }

  /**
   * Move a task to a bucket (or null = Inbox). This is the user's correction
   * signal: the previous training (if any) is reversed and the new bucket is
   * trained, so the classifier converges on the user's real filing habits.
   */
  setBucket(id: string, bucket: string | null): void {
    const task = this.requireTask(id);
    if (task.bucket === bucket) return;

    if (task.trainedBucket !== null) {
      untrain(this.doc.model, task.trainedBucket, task.title);
      task.trainedBucket = null;
    }
    if (bucket !== null) {
      this.requireBucket(bucket);
      train(this.doc.model, bucket, task.title);
      task.trainedBucket = bucket;
      this.promoteBucket(bucket);
    }
    this.doc.modelModifiedAt = this.now().toISOString();
    task.bucket = bucket;
    this.touch(task);
  }

  /**
   * Fallback when the statistical classifier is unsure: if the text clearly
   * matches a seed-lexicon concept (≥2 distinct vocabulary words), file it
   * into the matching existing bucket — or auto-create that bucket, unless
   * the user previously deleted one for the same concept (deletion is a
   * choice we respect; we never resurrect it).
   */
  private assignByLexicon(text: string): string | null {
    const match = matchConcept(tokenize(text));
    if (!match) return null;

    const existing = this.liveBucketForConcept(match.concept);
    if (existing) return existing;

    for (const bucket of Object.values(this.doc.buckets)) {
      if (bucket.deletedAt !== null && conceptForBucketName(bucket.name) === match.concept) {
        return null;
      }
    }
    this.createBucket(match.concept.name, "auto");
    return match.concept.name;
  }

  private liveBucketForConcept(concept: Concept): string | null {
    for (const name of this.listBuckets()) {
      if (conceptForBucketName(name) === concept) return name;
    }
    return null;
  }

  // ---- manual ordering ---------------------------------------------------

  /** "This is important" — the user's replacement for priority tags. */
  moveToTop(id: string): void {
    const task = this.requireTask(id);
    task.order = this.topOrder();
    this.touch(task);
  }

  /** Drag-reorder: place `id` directly after `afterId` (null = very top). */
  moveAfter(id: string, afterId: string | null): void {
    const task = this.requireTask(id);
    const siblings = this.listTasks("all").filter((t) => t.id !== id);

    if (afterId === null) {
      task.order = this.topOrder();
    } else {
      const index = siblings.findIndex((t) => t.id === afterId);
      if (index === -1) throw new Error(`Unknown task: ${afterId}`);
      const prev = siblings[index]!;
      const next = siblings[index + 1];
      task.order = next === undefined ? prev.order + 1 : (prev.order + next.order) / 2;
    }
    this.touch(task);
  }

  // ---- buckets -----------------------------------------------------------

  createBucket(name: string, origin: "user" | "auto" = "user"): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Bucket name cannot be empty");
    const ts = this.now().toISOString();
    const existing = this.doc.buckets[trimmed];
    if (existing && existing.deletedAt === null) return;
    const record = {
      name: trimmed,
      createdAt: existing?.createdAt ?? ts,
      modifiedAt: ts,
      deletedAt: null,
      seeded: existing?.seeded ?? false,
      origin,
    };
    this.doc.buckets[trimmed] = record;
    ensureBucket(this.doc.model, trimmed);

    const concept = conceptForBucketName(trimmed);
    if (concept && !record.seeded) {
      seed(this.doc.model, trimmed, concept.vocabulary);
      record.seeded = true;
      this.doc.modelModifiedAt = ts;
    }
    this.scheduleSave();
  }

  /**
   * Bucket names for the pill bar: user-created/adopted buckets first (in
   * creation order), auto-generated ones after.
   */
  listBuckets(): string[] {
    return this.listBucketDetails().map((b) => b.name);
  }

  /** Pill-bar detail: name + whether the bucket is still auto-generated. */
  listBucketDetails(): Array<{ name: string; auto: boolean }> {
    return Object.values(this.doc.buckets)
      .filter((b) => b.deletedAt === null)
      .sort((a, b) => {
        const autoA = a.origin === "auto" ? 1 : 0;
        const autoB = b.origin === "auto" ? 1 : 0;
        return autoA - autoB || a.createdAt.localeCompare(b.createdAt);
      })
      .map((b) => ({ name: b.name, auto: b.origin === "auto" }));
  }

  /** An auto bucket the user files into becomes theirs — visually and in ordering. */
  private promoteBucket(name: string): void {
    const bucket = this.doc.buckets[name];
    if (bucket && bucket.deletedAt === null && bucket.origin === "auto") {
      bucket.origin = "user";
      bucket.modifiedAt = this.now().toISOString();
    }
  }

  /** Tombstone the bucket; its live tasks fall back to the Inbox. */
  deleteBucket(name: string): void {
    const bucket = this.doc.buckets[name];
    if (!bucket || bucket.deletedAt !== null) return;
    const ts = this.now().toISOString();
    bucket.deletedAt = ts;
    bucket.modifiedAt = ts;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt === null && task.bucket === name) {
        if (task.trainedBucket === name) {
          untrain(this.doc.model, name, task.title);
          task.trainedBucket = null;
          this.doc.modelModifiedAt = ts;
        }
        task.bucket = null;
        task.modifiedAt = ts;
      }
    }
    this.scheduleSave();
  }

  // ---- sync & persistence --------------------------------------------------

  /** Fold a remote copy of the document into this one (Phase 4 entry point). */
  mergeRemote(remote: StoreDoc): void {
    this.doc = mergeDocs(this.doc, remote);
    this.scheduleSave();
  }

  /** Snapshot for upload to a remote. */
  exportDoc(): string {
    return serializeDoc(this.doc);
  }

  /** Resolves when all scheduled saves have hit the persistence adapter. */
  flush(): Promise<void> {
    return this.saveChain;
  }

  // ---- internals -----------------------------------------------------------

  private topOrder(): number {
    const live = Object.values(this.doc.tasks).filter((t) => t.deletedAt === null);
    return live.length === 0 ? 0 : Math.min(...live.map((t) => t.order)) - 1;
  }

  private isLiveBucket(name: string): boolean {
    const bucket = this.doc.buckets[name];
    return bucket !== undefined && bucket.deletedAt === null;
  }

  private requireBucket(name: string): void {
    if (!this.isLiveBucket(name)) throw new Error(`Unknown bucket: ${name}`);
  }

  private requireTask(id: string): TaskRecord {
    const task = this.doc.tasks[id];
    if (!task || task.deletedAt !== null) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private touch(task: TaskRecord): void {
    task.modifiedAt = this.now().toISOString();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    const snapshot = serializeDoc(this.doc);
    this.saveChain = this.saveChain.then(() => this.persistence.save(snapshot));
  }
}
