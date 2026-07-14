/**
 * Share-a-copy links.
 *
 * The whole list travels *inside* the URL — there is no server. The current
 * document is trimmed (deleted tombstones and the classifier model dropped,
 * since a recipient only needs the visible tasks and buckets), serialized,
 * and packed into the URL fragment. Opening that link rehydrates a full
 * StoreDoc on the other side, which the app loads into an isolated, in-memory
 * copy — so the recipient can edit freely without ever touching the sharer's
 * (or their own) saved list.
 *
 * This module is pure and DOM-free (runs under `node --test`); the browser-only
 * gzip step lives in the UI layer and is signalled by a one-char flag prefix.
 */

import type { StoreDoc, TaskRecord, BucketRecord } from "../storage/doc.js";
import { createModel } from "../engine/classify.js";

/** URL fragment key: links look like `…/#s=<flag><base64url>`. */
export const SHARE_HASH_KEY = "s";

/**
 * A compact, shareable copy of the document: live tasks and buckets only, with
 * an empty classifier model (the recipient's lexicon still seeds their buckets,
 * and dropping the trained model keeps links short).
 */
export function buildShareDoc(doc: StoreDoc): StoreDoc {
  const tasks: Record<string, TaskRecord> = {};
  for (const [id, task] of Object.entries(doc.tasks)) {
    if (task.deletedAt) continue; // don't ship tombstones
    tasks[id] = task;
  }
  const buckets: Record<string, BucketRecord> = {};
  for (const [name, bucket] of Object.entries(doc.buckets)) {
    if (bucket.deletedAt) continue;
    buckets[name] = bucket;
  }
  return {
    version: 1,
    tasks,
    buckets,
    model: createModel(),
    // Epoch timestamp so that if a recipient later "saves a copy", the merge's
    // last-write-wins never lets this empty model clobber their trained one.
    modelModifiedAt: new Date(0).toISOString(),
    setupVersion: doc.setupVersion,
  };
}

/** Serialize a document into the compact JSON that gets packed into a link. */
export function packShare(doc: StoreDoc): string {
  return JSON.stringify(buildShareDoc(doc));
}

/** Rehydrate the JSON from a link back into a full, loadable StoreDoc. */
export function unpackShare(json: string): StoreDoc {
  const doc = JSON.parse(json) as StoreDoc;
  if (doc.version !== 1) throw new Error("Unsupported shared list version");
  if (!doc.model) {
    doc.model = createModel();
    doc.modelModifiedAt = doc.modelModifiedAt ?? new Date(0).toISOString();
  }
  for (const task of Object.values(doc.tasks)) {
    if (!Array.isArray(task.buckets)) task.buckets = [];
    if (!Array.isArray(task.trainedBuckets)) task.trainedBuckets = [];
  }
  return doc;
}

// ---- URL-safe, UTF-8-safe base64 (works identically in Node and browsers) ---

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    if (b1 !== undefined) out += B64[(n >> 6) & 63]!;
    if (b2 !== undefined) out += B64[n & 63]!;
  }
  return out;
}

export function base64urlToBytes(text: string): Uint8Array {
  const clean = text.trim();
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B64_LOOKUP[clean.charCodeAt(i)] ?? -1;
    if (value < 0) continue; // skip stray padding / whitespace
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
