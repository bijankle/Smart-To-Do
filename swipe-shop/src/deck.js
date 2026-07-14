/**
 * Deck builder — decides what the user sees next. Mostly exploit (highest
 * predicted-appeal first, so the feed visibly sharpens as you swipe), with a
 * scheduled dose of explore: every Nth card is the product the model knows
 * least about, so the profile keeps broadening instead of tunnelling into
 * the first thing you liked.
 */

import { scoreProduct, noveltyOf } from "./profile.js";

/**
 * @param {import("./catalog.js").Product[]} catalog
 * @param {import("./profile.js").Profile} profile
 * @param {{ exploreEvery?: number, rng?: () => number }} [opts]
 *   exploreEvery — every Nth position is an exploration pick (default 4).
 *   rng — source of the tiny tie-breaking jitter; injectable for tests.
 * @returns {import("./catalog.js").Product[]} unseen products, best-first
 */
export function buildDeck(catalog, profile, opts = {}) {
  const exploreEvery = opts.exploreEvery ?? 4;
  const rng = opts.rng ?? Math.random;

  const seen = new Set(profile.swipes.map((s) => s.productId));
  const candidates = catalog
    .filter((p) => !seen.has(p.id))
    .map((p) => ({
      product: p,
      score: scoreProduct(profile, p) + rng() * 0.01,
      novelty: noveltyOf(profile, p) + rng() * 0.01,
    }));

  const byScore = [...candidates].sort((a, b) => b.score - a.score);
  const byNovelty = [...candidates].sort((a, b) => b.novelty - a.novelty);

  const taken = new Set();
  const deck = [];
  const takeFrom = (list) => {
    for (const c of list) {
      if (taken.has(c.product.id)) continue;
      taken.add(c.product.id);
      deck.push(c.product);
      return;
    }
  };

  while (deck.length < candidates.length) {
    const isExploreSlot = (deck.length + 1) % exploreEvery === 0;
    takeFrom(isExploreSlot ? byNovelty : byScore);
  }
  return deck;
}
