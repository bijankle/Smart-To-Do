/**
 * Phase 1 orchestrator: raw capture text → structured task fields.
 * Combines the deterministic date extractor with the Naive Bayes bucketer.
 */

import { extractDate, stripMatch, type DateMatch } from "./dates.js";
import { classify, type ClassifierModel } from "./classify.js";

/** Suggestions below this posterior land in the Inbox instead of a bucket. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.55;

export interface ParseOptions {
  /** Reference time for relative-date resolution. Defaults to the current time. */
  now?: Date;
  /** Trained classifier model; omit to skip bucketing. */
  model?: ClassifierModel;
  confidenceThreshold?: number;
}

export interface ParsedTask {
  /** Input with the recognized date expression removed. */
  title: string;
  /** Local YYYY-MM-DD due date, or null when no date expression was found. */
  due: string | null;
  /** The raw date expression that was matched, for UI highlighting/undo. */
  dateMatch: DateMatch | null;
  /** Suggested bucket, or null → Inbox. */
  bucket: string | null;
  /** Posterior probability of the suggested bucket (0 when none). */
  confidence: number;
}

export function parseTask(text: string, options: ParseOptions = {}): ParsedTask {
  const now = options.now ?? new Date();
  const threshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const dateMatch = extractDate(text, now);
  const title = dateMatch ? stripMatch(text, dateMatch) : text.trim();

  let bucket: string | null = null;
  let confidence = 0;
  if (options.model) {
    const result = classify(options.model, title);
    if (result && result.confidence >= threshold) {
      bucket = result.bucket;
      confidence = result.confidence;
    }
  }

  return { title, due: dateMatch?.date ?? null, dateMatch, bucket, confidence };
}
