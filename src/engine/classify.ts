/**
 * Phase 1b — Multinomial Naive Bayes with Laplace smoothing.
 *
 * Buckets are user-defined. The model is a plain JSON-serializable object of
 * token counts, so it lives in the same document store as the tasks and syncs
 * across devices for free. Every manual re-bucketing by the user becomes a
 * training example (train the new bucket, untrain the old one), so accuracy
 * improves locally with zero network calls.
 */

import { tokenize } from "./tokenize.js";

export interface BucketStats {
  /** Number of training examples filed into this bucket. */
  docCount: number;
  /** Token → occurrence count within this bucket. */
  tokenCounts: Record<string, number>;
  /** Sum of tokenCounts values (denormalized for speed). */
  totalTokens: number;
}

export interface ClassifierModel {
  version: 1;
  totalDocs: number;
  buckets: Record<string, BucketStats>;
}

export interface Classification {
  bucket: string;
  /** Normalized posterior probability of the winning bucket, in (0, 1]. */
  confidence: number;
}

export function createModel(bucketNames: string[] = []): ClassifierModel {
  const model: ClassifierModel = { version: 1, totalDocs: 0, buckets: {} };
  for (const name of bucketNames) ensureBucket(model, name);
  return model;
}

export function ensureBucket(model: ClassifierModel, bucket: string): BucketStats {
  let stats = model.buckets[bucket];
  if (!stats) {
    stats = { docCount: 0, tokenCounts: {}, totalTokens: 0 };
    model.buckets[bucket] = stats;
  }
  return stats;
}

/** Record `text` as a training example for `bucket`. Mutates the model in place. */
export function train(model: ClassifierModel, bucket: string, text: string): void {
  const stats = ensureBucket(model, bucket);
  stats.docCount += 1;
  model.totalDocs += 1;
  for (const token of tokenize(text)) {
    stats.tokenCounts[token] = (stats.tokenCounts[token] ?? 0) + 1;
    stats.totalTokens += 1;
  }
}

/**
 * Reverse a previous train() call, used when the user re-buckets a task.
 * Counts floor at zero so an unmatched untrain can never corrupt the model.
 */
export function untrain(model: ClassifierModel, bucket: string, text: string): void {
  const stats = model.buckets[bucket];
  if (!stats) return;
  if (stats.docCount > 0) {
    stats.docCount -= 1;
    model.totalDocs -= 1;
  }
  for (const token of tokenize(text)) {
    const count = stats.tokenCounts[token] ?? 0;
    if (count > 1) {
      stats.tokenCounts[token] = count - 1;
      stats.totalTokens -= 1;
    } else if (count === 1) {
      delete stats.tokenCounts[token];
      stats.totalTokens -= 1;
    }
  }
}

/** Distinct tokens across all buckets — the V in Laplace smoothing. */
function vocabularySize(model: ClassifierModel): number {
  const vocab = new Set<string>();
  for (const stats of Object.values(model.buckets)) {
    for (const token of Object.keys(stats.tokenCounts)) vocab.add(token);
  }
  return vocab.size;
}

/**
 * Classify `text` against the model. Returns null when the model has no
 * trained buckets or the text has no usable tokens — callers should treat
 * null (and confidences below their threshold) as "leave it in the Inbox".
 */
export function classify(model: ClassifierModel, text: string): Classification | null {
  const tokens = tokenize(text);
  const trained = Object.entries(model.buckets).filter(([, s]) => s.docCount > 0);
  if (tokens.length === 0 || trained.length === 0 || model.totalDocs === 0) return null;

  const vocab = vocabularySize(model);
  const logScores = trained.map(([name, stats]) => {
    let score = Math.log(stats.docCount / model.totalDocs);
    for (const token of tokens) {
      const count = stats.tokenCounts[token] ?? 0;
      score += Math.log((count + 1) / (stats.totalTokens + vocab));
    }
    return { name, score };
  });

  // Softmax over log scores → normalized posteriors, computed stably.
  const maxScore = Math.max(...logScores.map((s) => s.score));
  const exps = logScores.map((s) => Math.exp(s.score - maxScore));
  const sum = exps.reduce((a, b) => a + b, 0);

  let bestIndex = 0;
  for (let i = 1; i < exps.length; i++) {
    if (exps[i]! > exps[bestIndex]!) bestIndex = i;
  }
  return { bucket: logScores[bestIndex]!.name, confidence: exps[bestIndex]! / sum };
}
