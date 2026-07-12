/**
 * Phase 2 — Repository: the single API surface the UI talks to.
 *
 * Responsibilities:
 *  - Task CRUD with tombstone deletes and manual ordering (new tasks enter at
 *    the top — importance is expressed by position, not priority tags).
 *  - Multi-bucket membership: a capture can belong to several buckets at once
 *    ("onions and a hammer" → groceries AND hardware) but is one record, so
 *    completing it anywhere completes it everywhere. Tasks are never split.
 *  - Auto-tagging on capture via the Naive Bayes classifier with the seed
 *    lexicon as fallback; the model is trained ONLY by explicit user actions
 *    (capturing with a #tag or toggling a bucket), never by its own
 *    predictions, so it can't drift on its own.
 *  - Persistence after every mutation through the injected adapter.
 */

import { classify, createModel, ensureBucket, seed, train, untrain } from "../engine/classify.js";
import {
  CONCEPTS,
  conceptForBucketName,
  extraConceptsForBucketName,
  matchConcepts,
  type Concept,
} from "../engine/lexicon.js";
import { tokenize } from "../engine/tokenize.js";
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

/** Pill-bar filter: 'all' or a bucket name. Untagged tasks appear only in 'all'. */
export type TaskFilter = "all" | string;

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

  /**
   * One-time bespoke setup (recorded in the doc, so it runs once across ALL
   * devices): create the user's store pills and fold any generic starter
   * buckets into them — memberships and training move, then the generic
   * bucket is deleted. Stores the user tombstoned are never resurrected.
   */
  applyStoreSetup(stores: string[], remap: Record<string, string>): boolean {
    const version = this.doc.setupVersion ?? 0;
    if (version >= 6) return false;

    if (version < 2) this.applyPillSetup(stores, remap);
    // v4: the media feature (songs/films/books) was removed — drop those pills
    // and any tasks that only lived in them, then rebuild the classifier so its
    // seeds match the current concepts and refresh auto tags.
    if (version < 4) this.removeMediaFeature();
    // v5: the "Computer" pill was renamed "Computer tasks" — carry its tasks
    // and training across before it disappears.
    if (version < 5) this.foldBucket("Computer", "Computer tasks");
    // v6: new pills added (e.g. Outdoor) — create any the user has never had,
    // without resurrecting ones they deliberately deleted.
    if (version < 6) this.ensureNewPills(stores);
    this.rebuildClassifier();
    this.retagAuto();
    this.doc.setupVersion = 6;
    this.scheduleSave();
    return true;
  }

  /** Create pills that have never existed (skips live and tombstoned names). */
  private ensureNewPills(stores: string[]): void {
    for (const name of stores) {
      if (!this.doc.buckets[name]) this.createBucket(name);
    }
  }

  /**
   * Rename a bucket in place by moving every task's membership and training
   * from `from` to `to`, then tombstoning `from`. The classifier is rebuilt by
   * the caller, so only the record arrays are remapped here.
   */
  private foldBucket(from: string, to: string): void {
    if (!this.isLiveBucket(from)) return;
    if (!this.isLiveBucket(to)) this.createBucket(to);
    const ts = this.now().toISOString();
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || !task.buckets.includes(from)) continue;
      task.buckets = [...new Set(task.buckets.map((b) => (b === from ? to : b)))];
      task.trainedBuckets = [...new Set(task.trainedBuckets.map((b) => (b === from ? to : b)))];
      task.modifiedAt = ts;
    }
    this.deleteBucket(from);
  }

  /**
   * Retire the songs/films/books feature: tombstone the Music/Films/Books
   * pills and delete the media captures that lived only in them (or carried a
   * source link). Tasks that also belong to a real bucket keep it, just losing
   * the media membership when the bucket is deleted.
   */
  private removeMediaFeature(): void {
    const media = new Set(["Music", "Films", "Books"]);
    const ts = this.now().toISOString();
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null) continue;
      const onlyMedia = task.buckets.length > 0 && task.buckets.every((b) => media.has(b));
      if (task.link || onlyMedia) {
        task.deletedAt = ts;
        task.modifiedAt = ts;
      }
    }
    for (const name of media) {
      if (this.isLiveBucket(name)) this.deleteBucket(name);
    }
  }

  private applyPillSetup(stores: string[], remap: Record<string, string>): void {
    for (const store of stores) {
      if (!this.doc.buckets[store]) this.createBucket(store);
    }

    const remapLower = new Map(Object.entries(remap).map(([k, v]) => [k.toLowerCase(), v]));
    for (const bucket of Object.values(this.doc.buckets)) {
      if (bucket.deletedAt !== null) continue;
      const target = remapLower.get(bucket.name.toLowerCase());
      if (!target || target === bucket.name || !this.isLiveBucket(target)) continue;

      for (const task of Object.values(this.doc.tasks)) {
        if (task.deletedAt !== null || !task.buckets.includes(bucket.name)) continue;
        task.buckets = [...new Set(task.buckets.map((b) => (b === bucket.name ? target : b)))];
        if (task.trainedBuckets.includes(bucket.name)) {
          untrain(this.doc.model, bucket.name, task.title);
          train(this.doc.model, target, task.title);
          task.trainedBuckets = [
            ...new Set(task.trainedBuckets.map((b) => (b === bucket.name ? target : b))),
          ];
          this.doc.modelModifiedAt = this.now().toISOString();
        }
        task.modifiedAt = this.now().toISOString();
      }
      this.deleteBucket(bucket.name);
    }
  }

  /**
   * Rebuild the classifier from scratch: fresh seeds from the CURRENT
   * concepts for every live bucket, then replay the user's own training.
   * Run when concept definitions change shape between versions.
   */
  rebuildClassifier(): void {
    this.doc.model = createModel();
    const ts = this.now().toISOString();
    for (const bucket of Object.values(this.doc.buckets)) {
      if (bucket.deletedAt !== null) continue;
      ensureBucket(this.doc.model, bucket.name);
      const concept = conceptForBucketName(bucket.name);
      if (concept) {
        seed(this.doc.model, bucket.name, concept.vocabulary);
        bucket.seeded = true;
        bucket.modifiedAt = ts;
      }
    }
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null) continue;
      task.trainedBuckets = task.trainedBuckets.filter((b) => this.isLiveBucket(b));
      for (const bucket of task.trainedBuckets) train(this.doc.model, bucket, task.title);
    }
    this.doc.modelModifiedAt = ts;
    this.scheduleSave();
  }

  /**
   * Re-run auto-tagging on open tasks whose tags came purely from automation
   * (never hand-tagged). Only ever REPLACES tags when the fresh result is
   * non-empty, so a task the current lexicon can't reproduce is left alone.
   */
  retagAuto(): void {
    let changed = false;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || task.done || task.manualTags) continue;
      if (task.trainedBuckets.length > 0) continue;
      const tags = this.autoTag(task.title);
      if (tags.length === 0) continue;
      const same =
        tags.length === task.buckets.length && tags.every((t) => task.buckets.includes(t));
      if (!same) {
        task.buckets = tags;
        task.modifiedAt = this.now().toISOString();
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  // ---- tasks -------------------------------------------------------------

  /**
   * Capture a task. With an explicit bucket the classifier is trained on it;
   * otherwise the classifier suggests one, with the seed lexicon as fallback —
   * which may tag the task into SEVERAL buckets for mixed captures. Unclear
   * captures stay untagged (visible in All only). New tasks enter at the top.
   */
  addTask(title: string, bucket?: string): TaskRecord {
    const trimmed = title.trim();
    const ts = this.now().toISOString();
    let assigned: string[] = [];
    const trainedBuckets: string[] = [];

    if (bucket !== undefined) {
      this.requireBucket(bucket);
      assigned = [bucket];
      train(this.doc.model, bucket, trimmed);
      this.doc.modelModifiedAt = ts;
      trainedBuckets.push(bucket);
      this.promoteBucket(bucket);
    } else {
      assigned = this.autoTag(trimmed);
    }

    const task: TaskRecord = {
      id: this.newId(),
      title: trimmed,
      buckets: assigned,
      done: false,
      completedAt: null,
      order: this.topOrder(),
      createdAt: ts,
      modifiedAt: ts,
      deletedAt: null,
      trainedBuckets,
    };
    this.doc.tasks[task.id] = task;
    this.scheduleSave();
    return task;
  }

  /**
   * Suggest buckets for a capture: the statistical classifier first, then the
   * seed lexicon (which may map a mixed capture to SEVERAL buckets). Tagging
   * only ever targets buckets the user already has — nothing is auto-created.
   */
  private autoTag(text: string): string[] {
    const lexicon: string[] = [];
    for (const concept of matchConcepts(tokenize(text))) {
      // ALL buckets of the concept: someone who shops at both Coles and
      // Woolworths wants grocery items on both stores' lists.
      lexicon.push(...this.liveBucketsForConcept(concept));
    }
    // A mixed capture spanning several buckets ("celery and a drill bit")
    // beats the classifier's single-bucket guess, which would otherwise let
    // the dominant category drown out the other item.
    if (lexicon.length >= 2) return lexicon;

    const suggestion = classify(this.doc.model, text);
    // Coverage guard: one recognized word inside a long unrelated sentence
    // ("watch the onion movie trailer") is coincidence, not a category.
    const covered =
      suggestion !== null &&
      (suggestion.tokensUsed >= 2 || suggestion.tokensUsed * 2 >= suggestion.tokensTotal);
    if (suggestion && covered && suggestion.confidence >= this.threshold && this.isLiveBucket(suggestion.bucket)) {
      return [suggestion.bucket];
    }
    return lexicon;
  }

  private liveBucketsForConcept(concept: Concept): string[] {
    return this.listBuckets().filter(
      (name) =>
        conceptForBucketName(name) === concept ||
        extraConceptsForBucketName(name).has(concept.name),
    );
  }

  /** Live buckets mapped to a concept name (for the online product lookup). */
  bucketsForConceptName(conceptName: string): string[] {
    const concept = CONCEPTS.find((c) => c.name === conceptName);
    return concept ? this.liveBucketsForConcept(concept) : [];
  }

  /**
   * Apply background-suggested tags from the online lookup. Deliberately timid:
   * only fires on live, open, still-untagged tasks the user has never touched,
   * so it can never override a manual choice or an existing tag.
   */
  setSuggestedTags(id: string, buckets: string[]): boolean {
    const task = this.doc.tasks[id];
    if (!task || task.deletedAt !== null || task.done) return false;
    if (task.buckets.length > 0 || task.manualTags || task.trainedBuckets.length > 0) return false;
    const live = [...new Set(buckets.filter((b) => this.isLiveBucket(b)))];
    if (live.length === 0) return false;
    task.buckets = live;
    this.touch(task);
    return true;
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
    return filter === "all" ? true : task.buckets.includes(filter);
  }

  getTask(id: string): TaskRecord | null {
    const task = this.doc.tasks[id];
    return task && task.deletedAt === null ? task : null;
  }

  setDone(id: string, done: boolean): void {
    const task = this.requireTask(id);
    task.done = done;
    task.completedAt = done ? this.now().toISOString() : null;
    this.touch(task);
  }

  renameTask(id: string, title: string): void {
    const task = this.requireTask(id);
    const trimmed = title.trim();
    // Re-point any training at the new wording so untrain stays symmetric.
    if (task.trainedBuckets.length > 0) {
      for (const bucket of task.trainedBuckets) {
        untrain(this.doc.model, bucket, task.title);
        train(this.doc.model, bucket, trimmed);
      }
      this.doc.modelModifiedAt = this.now().toISOString();
    }
    task.title = trimmed;
    // The user hasn't hand-filed this task, so fixing a typo ("medcical" →
    // "medical") should re-run auto-tagging against the corrected text.
    if (task.trainedBuckets.length === 0 && !task.done) {
      task.buckets = this.autoTag(trimmed);
    }
    this.touch(task);
  }

  deleteTask(id: string): void {
    const task = this.requireTask(id);
    task.deletedAt = this.now().toISOString();
    this.touch(task);
  }

  /**
   * Toggle a task's membership in a bucket — the user's correction signal.
   * Adding trains the classifier on the pairing (and adopts auto buckets);
   * removing reverses any training this task contributed there.
   */
  toggleBucket(id: string, bucket: string): void {
    const task = this.requireTask(id);
    const ts = this.now().toISOString();
    task.manualTags = true;
    if (task.buckets.includes(bucket)) {
      task.buckets = task.buckets.filter((b) => b !== bucket);
      if (task.trainedBuckets.includes(bucket)) {
        untrain(this.doc.model, bucket, task.title);
        task.trainedBuckets = task.trainedBuckets.filter((b) => b !== bucket);
        this.doc.modelModifiedAt = ts;
      }
    } else {
      this.requireBucket(bucket);
      task.buckets = [...task.buckets, bucket];
      train(this.doc.model, bucket, task.title);
      task.trainedBuckets = [...task.trainedBuckets, bucket];
      this.doc.modelModifiedAt = ts;
      this.promoteBucket(bucket);
    }
    this.touch(task);
  }

  /**
   * Re-apply auto-tagging to open, untagged tasks the user hasn't touched —
   * the vocabulary grows over time, so yesterday's unrecognized "bandaids"
   * can file itself today. Runs cheaply on every app start.
   */
  retagUntagged(): void {
    let changed = false;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || task.done || task.manualTags) continue;
      if (task.buckets.length > 0 || task.trainedBuckets.length > 0) continue;
      const tags = this.autoTag(task.title);
      if (tags.length > 0) {
        task.buckets = tags;
        task.modifiedAt = this.now().toISOString();
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /**
   * One-off heal: strip Markdown table pipes from existing task titles, so
   * lists pasted before pipe-cleaning existed ("| Camping hammock |") read
   * cleanly. Idempotent — a title with no pipes is left untouched.
   */
  stripTitleFormatting(): number {
    const ts = this.now().toISOString();
    let count = 0;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || !task.title.includes("|")) continue;
      const cleaned = task.title.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
      if (cleaned && cleaned !== task.title) {
        task.title = cleaned;
        task.modifiedAt = ts;
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  /**
   * Clear the current view. In a bucket view, every open task is un-filed from
   * that bucket; one still needed elsewhere ("condoms" in Coles AND Chemist)
   * keeps its other memberships, and one left with none is deleted. In "all",
   * every open task is deleted. The trained model is left intact, so cleared
   * items still auto-tag correctly next time. Returns how many were affected.
   */
  clearFilter(filter: TaskFilter): number {
    const ts = this.now().toISOString();
    let count = 0;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || task.done) continue;
      if (filter !== "all") {
        if (!task.buckets.includes(filter)) continue;
        task.buckets = task.buckets.filter((b) => b !== filter);
        task.trainedBuckets = task.trainedBuckets.filter((b) => b !== filter);
        if (task.buckets.length > 0) {
          task.modifiedAt = ts;
          count++;
          continue;
        }
      }
      task.deletedAt = ts;
      task.modifiedAt = ts;
      count++;
    }
    if (count > 0) this.scheduleSave();
    return count;
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

  /** Tombstone the bucket; tasks lose that membership (other memberships stay). */
  deleteBucket(name: string): void {
    const bucket = this.doc.buckets[name];
    if (!bucket || bucket.deletedAt !== null) return;
    const ts = this.now().toISOString();
    bucket.deletedAt = ts;
    bucket.modifiedAt = ts;
    // Purge its classifier stats too, so a dead bucket can't win suggestions.
    const stats = this.doc.model.buckets[name];
    if (stats) {
      this.doc.model.totalDocs = Math.max(0, this.doc.model.totalDocs - stats.docCount);
      delete this.doc.model.buckets[name];
      this.doc.modelModifiedAt = ts;
    }
    for (const task of Object.values(this.doc.tasks)) {
      if (task.deletedAt !== null || !task.buckets.includes(name)) continue;
      task.buckets = task.buckets.filter((b) => b !== name);
      if (task.trainedBuckets.includes(name)) {
        untrain(this.doc.model, name, task.title);
        task.trainedBuckets = task.trainedBuckets.filter((b) => b !== name);
        this.doc.modelModifiedAt = ts;
      }
      task.modifiedAt = ts;
    }
    this.scheduleSave();
  }

  // ---- sync & persistence --------------------------------------------------

  /** Fold a remote copy of the document into this one (Phase 4 entry point). */
  mergeRemote(remote: StoreDoc): void {
    this.doc = mergeDocs(this.doc, remote);
    this.scheduleSave();
  }

  /** Snapshot for upload to a remote, or for the undo/redo history. */
  exportDoc(): string {
    return serializeDoc(this.doc);
  }

  /** Replace the whole document with a snapshot (undo/redo). Persists it. */
  restoreSnapshot(snapshot: string): void {
    this.doc = deserializeDoc(snapshot);
    this.scheduleSave();
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
