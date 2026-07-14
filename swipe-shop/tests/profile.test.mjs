import test from "node:test";
import assert from "node:assert/strict";

import { CATALOG, productFeatures, priceBand, productUrl } from "../src/catalog.js";
import {
  createProfile,
  recordSwipe,
  undoLastSwipe,
  featureAffinity,
  scoreProduct,
  noveltyOf,
  tasteSummary,
  profileStrength,
  shortlist,
} from "../src/profile.js";

const byId = new Map(CATALOG.map((p) => [p.id, p]));
const product = (id) => {
  const p = byId.get(id);
  assert.ok(p, `catalog is missing ${id}`);
  return p;
};

test("catalog is well-formed", () => {
  assert.ok(CATALOG.length >= 50, "catalog should be a real deck");
  const ids = new Set(CATALOG.map((p) => p.id));
  assert.equal(ids.size, CATALOG.length, "ids must be unique");
  for (const p of CATALOG) {
    assert.ok(p.title && p.brand && p.emoji && p.blurb, `${p.id} has display fields`);
    assert.ok(p.price > 0, `${p.id} has a price`);
    assert.ok(p.tags.length >= 3, `${p.id} has learnable tags`);
    const url = new URL(productUrl(p));
    assert.equal(url.protocol, "https:", `${p.id} links out over https`);
  }
});

test("price bands split at 20 / 75 / 200", () => {
  assert.equal(priceBand(19.99), "budget");
  assert.equal(priceBand(20), "mid");
  assert.equal(priceBand(74.99), "mid");
  assert.equal(priceBand(75), "premium");
  assert.equal(priceBand(200), "luxury");
});

test("features are namespaced and cover every learnable axis", () => {
  const f = productFeatures(product("fa-01"));
  assert.ok(f.includes("cat:fashion"));
  assert.ok(f.includes("brand:Norse Atelier"));
  assert.ok(f.includes("platform:asos"));
  assert.ok(f.includes("price:premium"));
  assert.ok(f.includes("tag:minimalist"));
});

test("liking a product raises the score of similar products", () => {
  const profile = createProfile();
  const coat = product("fa-01"); // minimalist / cozy / neutral
  const cashmere = product("fa-08"); // shares minimalist, cozy, neutral
  const gamingChair = product("ga-04"); // shares nothing

  const before = scoreProduct(profile, cashmere);
  recordSwipe(profile, coat, "like", 1);
  assert.ok(scoreProduct(profile, cashmere) > before, "similar product should rise");
  assert.ok(scoreProduct(profile, cashmere) > scoreProduct(profile, gamingChair));
});

test("nope lowers similar products; love counts double", () => {
  const noped = createProfile();
  recordSwipe(noped, product("fa-01"), "nope", 1);
  assert.ok(scoreProduct(noped, product("fa-08")) < 0);

  const liked = createProfile();
  const loved = createProfile();
  recordSwipe(liked, product("fa-01"), "like", 1);
  recordSwipe(loved, product("fa-01"), "love", 1);
  assert.ok(
    scoreProduct(loved, product("fa-08")) > scoreProduct(liked, product("fa-08")),
    "love is a stronger positive signal than like",
  );
});

test("affinity is smoothed: one swipe never saturates", () => {
  const profile = createProfile();
  recordSwipe(profile, product("fa-01"), "like", 1);
  const a = featureAffinity(profile.stats["tag:minimalist"]);
  assert.ok(a > 0 && a < 0.5, `smoothed single-like affinity should be moderate, got ${a}`);
});

test("undo restores scores and swipe history exactly", () => {
  const profile = createProfile();
  recordSwipe(profile, product("te-01"), "like", 1);
  const snapshot = JSON.stringify(profile.stats);
  const score = scoreProduct(profile, product("te-02"));

  recordSwipe(profile, product("ki-06"), "love", 2);
  const undone = undoLastSwipe(profile, byId);

  assert.equal(undone.productId, "ki-06");
  assert.equal(profile.swipes.length, 1);
  assert.equal(scoreProduct(profile, product("te-02")), score);
  // Every stat touched by the undone swipe is back to zero-or-prior.
  for (const [feature, stat] of Object.entries(JSON.parse(snapshot))) {
    assert.deepEqual(profile.stats[feature], stat, feature);
  }
  assert.equal(undoLastSwipe(createProfile(), byId), null);
});

test("novelty starts at 1 and falls with evidence", () => {
  const profile = createProfile();
  assert.equal(noveltyOf(profile, product("fa-01")), 1);
  recordSwipe(profile, product("fa-01"), "like", 1);
  assert.ok(noveltyOf(profile, product("fa-01")) < 1);
  assert.ok(noveltyOf(profile, product("fa-08")) < 1, "shared features count as evidence");
  assert.ok(noveltyOf(profile, product("ga-04")) === 1, "untouched product stays fully novel");
});

test("tasteSummary surfaces convictions and hides one-off noise", () => {
  const profile = createProfile();
  recordSwipe(profile, product("fa-01"), "like", 1); // minimalist, cozy...
  recordSwipe(profile, product("fa-08"), "like", 2); // minimalist, cozy...
  recordSwipe(profile, product("ga-04"), "nope", 3);
  recordSwipe(profile, product("ga-01"), "nope", 4);

  const s = tasteSummary(profile);
  assert.deepEqual(
    { like: s.totals.like, nope: s.totals.nope, love: s.totals.love, all: s.totals.all },
    { like: 2, nope: 2, love: 0, all: 4 },
  );
  const tagValues = s.traits.tag.map((t) => t.value);
  assert.ok(tagValues.includes("minimalist"), "repeated likes become a trait");
  assert.ok(!tagValues.includes("layering"), "single-evidence tags stay hidden");
  assert.ok(s.avoid.some((a) => a.kind === "cat" && a.value === "gaming"), "repeated nopes become an avoid");
});

test("profileStrength grows with swipes", () => {
  const profile = createProfile();
  assert.equal(profileStrength(profile).label, "Untrained");
  for (let i = 0; i < 50; i++) recordSwipe(profile, product("fa-01"), "like", i);
  assert.deepEqual(profileStrength(profile), { label: "Dialed in", pct: 100 });
});

test("shortlist keeps likes and loves, loves first, and skips nopes", () => {
  const profile = createProfile();
  recordSwipe(profile, product("fa-01"), "like", 1);
  recordSwipe(profile, product("ga-04"), "nope", 2);
  recordSwipe(profile, product("te-01"), "love", 3);
  recordSwipe(profile, product("ki-02"), "like", 4);

  const picks = shortlist(profile, byId);
  assert.deepEqual(
    picks.map((p) => p.product.id),
    ["te-01", "ki-02", "fa-01"],
  );
});
