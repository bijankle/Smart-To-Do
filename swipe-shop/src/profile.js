/**
 * The taste engine. Every swipe is evidence for or against each feature of
 * the product (its category, brand, platform, price band, and style tags).
 * A product's score is the average smoothed affinity of its features, so the
 * model generalises: liking two cozy/minimalist things raises every other
 * cozy/minimalist thing in the deck, even from a category you haven't seen.
 *
 * @typedef {"like"|"love"|"nope"} Verdict
 * @typedef {{ productId: string, verdict: Verdict, at: number }} Swipe
 * @typedef {{ likes: number, nopes: number }} FeatureStat
 * @typedef {{ swipes: Swipe[], stats: Record<string, FeatureStat> }} Profile
 */

import { productFeatures, featureParts } from "./catalog.js";

/** A "love" (super-like) counts double — it's a much stronger signal. */
export const VERDICT_WEIGHTS = { like: 1, love: 2, nope: 1 };

/** Laplace-style smoothing so one swipe never yields a fanatical ±1. */
const SMOOTHING = 2;

/** @returns {Profile} */
export function createProfile() {
  return { swipes: [], stats: {} };
}

function statFor(profile, feature) {
  return (profile.stats[feature] ??= { likes: 0, nopes: 0 });
}

/**
 * Record one swipe and update every feature the product carries.
 * @param {Profile} profile @param {import("./catalog.js").Product} product
 * @param {Verdict} verdict @param {number} [at]
 */
export function recordSwipe(profile, product, verdict, at = Date.now()) {
  const w = VERDICT_WEIGHTS[verdict];
  for (const f of productFeatures(product)) {
    const s = statFor(profile, f);
    if (verdict === "nope") s.nopes += w;
    else s.likes += w;
  }
  profile.swipes.push({ productId: product.id, verdict, at });
}

/**
 * Reverse the most recent swipe (the product goes back on the deck).
 * @param {Profile} profile
 * @param {Map<string, import("./catalog.js").Product>} byId
 * @returns {Swipe | null} the removed swipe, or null if there was none
 */
export function undoLastSwipe(profile, byId) {
  const swipe = profile.swipes.pop();
  if (!swipe) return null;
  const product = byId.get(swipe.productId);
  if (product) {
    const w = VERDICT_WEIGHTS[swipe.verdict];
    for (const f of productFeatures(product)) {
      const s = statFor(profile, f);
      if (swipe.verdict === "nope") s.nopes = Math.max(0, s.nopes - w);
      else s.likes = Math.max(0, s.likes - w);
    }
  }
  return swipe;
}

/**
 * Smoothed affinity for one feature, in (-1, 1). 0 = no signal.
 * @param {FeatureStat | undefined} stat
 */
export function featureAffinity(stat) {
  if (!stat) return 0;
  const { likes, nopes } = stat;
  return (likes - nopes) / (likes + nopes + SMOOTHING);
}

/** How much evidence the model has about a feature. */
export function featureEvidence(stat) {
  return stat ? stat.likes + stat.nopes : 0;
}

/**
 * Predicted appeal of a product for this profile, in (-1, 1).
 * @param {Profile} profile @param {import("./catalog.js").Product} product
 */
export function scoreProduct(profile, product) {
  const features = productFeatures(product);
  let sum = 0;
  for (const f of features) sum += featureAffinity(profile.stats[f]);
  return sum / features.length;
}

/**
 * How unfamiliar a product is to the model (0–1): the inverse of the average
 * evidence across its features. Fresh categories/brands score high, which is
 * what the deck uses to keep exploring instead of tunnelling.
 */
export function noveltyOf(profile, product) {
  const features = productFeatures(product);
  let evidence = 0;
  for (const f of features) evidence += featureEvidence(profile.stats[f]);
  return 1 / (1 + evidence / features.length);
}

/**
 * A human-readable readout of what the model has learned, grouped by feature
 * kind. Only features with enough evidence make the cut — the profile page
 * should show convictions, not noise.
 *
 * @param {Profile} profile
 * @param {{ minEvidence?: number, limit?: number }} [opts]
 * @returns {{
 *   totals: { like: number, love: number, nope: number, all: number },
 *   traits: Record<string, Array<{ value: string, affinity: number, evidence: number }>>,
 *   avoid: Array<{ kind: string, value: string, affinity: number, evidence: number }>,
 * }}
 */
export function tasteSummary(profile, opts = {}) {
  const minEvidence = opts.minEvidence ?? 2;
  const limit = opts.limit ?? 6;

  const totals = { like: 0, love: 0, nope: 0, all: profile.swipes.length };
  for (const s of profile.swipes) totals[s.verdict] += 1;

  /** @type {Record<string, Array<{value: string, affinity: number, evidence: number}>>} */
  const traits = { tag: [], cat: [], brand: [], platform: [], price: [] };
  const avoid = [];

  for (const [feature, stat] of Object.entries(profile.stats)) {
    const evidence = featureEvidence(stat);
    if (evidence < minEvidence) continue;
    const affinity = featureAffinity(stat);
    const { kind, value } = featureParts(feature);
    if (affinity > 0 && traits[kind]) traits[kind].push({ value, affinity, evidence });
    if (affinity <= -0.25) avoid.push({ kind, value, affinity, evidence });
  }

  for (const kind of Object.keys(traits)) {
    traits[kind].sort((a, b) => b.affinity - a.affinity || b.evidence - a.evidence);
    traits[kind] = traits[kind].slice(0, limit);
  }
  avoid.sort((a, b) => a.affinity - b.affinity || b.evidence - a.evidence);

  return { totals, traits, avoid: avoid.slice(0, limit) };
}

/**
 * How trained the model feels, for the header meter.
 * @param {Profile} profile
 * @returns {{ label: string, pct: number }}
 */
export function profileStrength(profile) {
  const n = profile.swipes.length;
  const pct = Math.min(100, Math.round((n / 50) * 100));
  if (n === 0) return { label: "Untrained", pct };
  if (n < 10) return { label: "Warming up", pct };
  if (n < 25) return { label: "Learning you", pct };
  if (n < 50) return { label: "Getting sharp", pct };
  return { label: "Dialed in", pct };
}

/**
 * The user's shortlist: everything they liked or loved, loves first,
 * most recent first within each group. This is the list that links out
 * to the shopping sites.
 * @param {Profile} profile
 * @param {Map<string, import("./catalog.js").Product>} byId
 */
export function shortlist(profile, byId) {
  const picks = [];
  for (const s of profile.swipes) {
    if (s.verdict === "nope") continue;
    const product = byId.get(s.productId);
    if (product) picks.push({ product, verdict: s.verdict, at: s.at });
  }
  picks.sort((a, b) => (a.verdict === b.verdict ? b.at - a.at : a.verdict === "love" ? -1 : 1));
  return picks;
}
