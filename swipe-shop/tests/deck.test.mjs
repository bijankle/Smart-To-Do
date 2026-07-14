import test from "node:test";
import assert from "node:assert/strict";

import { CATALOG } from "../src/catalog.js";
import { createProfile, recordSwipe, scoreProduct } from "../src/profile.js";
import { buildDeck } from "../src/deck.js";

const byId = new Map(CATALOG.map((p) => [p.id, p]));
const noJitter = () => 0;

test("a fresh profile gets the full catalog", () => {
  const deck = buildDeck(CATALOG, createProfile(), { rng: noJitter });
  assert.equal(deck.length, CATALOG.length);
  assert.equal(new Set(deck.map((p) => p.id)).size, CATALOG.length, "no duplicates");
});

test("swiped products never come back", () => {
  const profile = createProfile();
  recordSwipe(profile, byId.get("fa-01"), "like", 1);
  recordSwipe(profile, byId.get("ga-04"), "nope", 2);
  const deck = buildDeck(CATALOG, profile, { rng: noJitter });
  assert.equal(deck.length, CATALOG.length - 2);
  assert.ok(!deck.some((p) => p.id === "fa-01" || p.id === "ga-04"));
});

test("the deck leads with what the profile predicts you'll like", () => {
  const profile = createProfile();
  // Teach it: loves cozy-minimalist fashion, hates gaming gear.
  recordSwipe(profile, byId.get("fa-01"), "love", 1);
  recordSwipe(profile, byId.get("fa-08"), "love", 2);
  recordSwipe(profile, byId.get("ho-01"), "like", 3);
  recordSwipe(profile, byId.get("ga-01"), "nope", 4);
  recordSwipe(profile, byId.get("ga-04"), "nope", 5);

  const deck = buildDeck(CATALOG, profile, { rng: noJitter });
  assert.equal(
    scoreProduct(profile, deck[0]),
    Math.max(...deck.map((p) => scoreProduct(profile, p))),
    "top card is the highest-scoring unseen product",
  );
  const positions = Object.fromEntries(deck.map((p, i) => [p.id, i]));
  assert.ok(positions["fa-05"] < positions["ga-02"], "cozy fashion outranks gaming");
});

test("every 4th card is an exploration pick, not just more of the same", () => {
  const profile = createProfile();
  recordSwipe(profile, byId.get("fa-01"), "love", 1);
  recordSwipe(profile, byId.get("fa-08"), "love", 2);

  const deck = buildDeck(CATALOG, profile, { rng: noJitter, exploreEvery: 4 });
  // Position 4 (index 3) must be a maximally novel product: one sharing no
  // features with anything swiped so far.
  const explorePick = deck[3];
  const swipedFeatures = new Set(
    ["fa-01", "fa-08"].flatMap((id) => {
      const p = byId.get(id);
      return [`cat:${p.category}`, ...p.tags.map((t) => `tag:${t}`)];
    }),
  );
  assert.ok(
    !explorePick.tags.some((t) => swipedFeatures.has(`tag:${t}`)) &&
      !swipedFeatures.has(`cat:${explorePick.category}`),
    `explore slot should be unfamiliar territory, got ${explorePick.id}`,
  );
});

test("deck is deterministic under a fixed rng", () => {
  const profile = createProfile();
  recordSwipe(profile, byId.get("te-01"), "like", 1);
  const a = buildDeck(CATALOG, profile, { rng: noJitter }).map((p) => p.id);
  const b = buildDeck(CATALOG, profile, { rng: noJitter }).map((p) => p.id);
  assert.deepEqual(a, b);
});
