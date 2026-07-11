import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createModel, train, untrain, classify } from "../src/engine/classify.js";
import { parseTask } from "../src/engine/parse.js";

function trainedModel() {
  const model = createModel(["Work", "Errands"]);
  train(model, "Work", "prepare quarterly report slides");
  train(model, "Work", "email client about contract renewal");
  train(model, "Work", "review pull request for api service");
  train(model, "Errands", "buy groceries milk eggs bread");
  train(model, "Errands", "pick up dry cleaning");
  train(model, "Errands", "return package at post office");
  return model;
}

describe("Naive Bayes classifier", () => {
  it("returns null for an untrained model or empty text", () => {
    assert.equal(classify(createModel(["Work"]), "buy milk"), null);
    assert.equal(classify(trainedModel(), "!!!"), null);
  });

  it("routes texts to the bucket with overlapping vocabulary", () => {
    const model = trainedModel();
    assert.equal(classify(model, "email the client")?.bucket, "Work");
    assert.equal(classify(model, "buy milk at the store")?.bucket, "Errands");
  });

  it("reports higher confidence for stronger token overlap", () => {
    const model = trainedModel();
    const strong = classify(model, "prepare report slides for client")!;
    const weak = classify(model, "prepare something")!;
    assert.ok(strong.confidence > weak.confidence);
    assert.ok(strong.confidence > 0.5 && strong.confidence <= 1);
  });

  it("learns from a correction via untrain + train", () => {
    const model = trainedModel();
    // User keeps filing "gym" tasks; a correction moves one from Errands to a new bucket.
    train(model, "Errands", "gym session leg day");
    assert.equal(classify(model, "gym session")?.bucket, "Errands");

    untrain(model, "Errands", "gym session leg day");
    train(model, "Health", "gym session leg day");
    train(model, "Health", "gym cardio session");
    assert.equal(classify(model, "gym session")?.bucket, "Health");
  });

  it("untrain floors at zero and never corrupts counts", () => {
    const model = createModel();
    train(model, "Work", "one two");
    untrain(model, "Work", "one two three");
    untrain(model, "Work", "one two three");
    assert.equal(model.totalDocs, 0);
    assert.equal(model.buckets["Work"]!.totalTokens, 0);
    assert.deepEqual(model.buckets["Work"]!.tokenCounts, {});
  });

  it("survives a JSON round-trip (sync-readiness)", () => {
    const model = trainedModel();
    const revived = JSON.parse(JSON.stringify(model));
    assert.equal(classify(revived, "email the client")?.bucket, "Work");
  });
});

describe("parseTask — full pipeline", () => {
  const MONDAY = new Date(2026, 6, 6);

  it("extracts the date, strips the title, and buckets the remainder", () => {
    const parsed = parseTask("buy groceries tomorrow", {
      now: MONDAY,
      model: trainedModel(),
      confidenceThreshold: 0.5,
    });
    assert.equal(parsed.title, "buy groceries");
    assert.equal(parsed.due, "2026-07-07");
    assert.equal(parsed.bucket, "Errands");
    assert.ok(parsed.confidence >= 0.5);
  });

  it("falls back to Inbox (null bucket) below the confidence threshold", () => {
    const parsed = parseTask("zebra xylophone", {
      now: MONDAY,
      model: trainedModel(),
      confidenceThreshold: 0.99,
    });
    assert.equal(parsed.bucket, null);
    assert.equal(parsed.confidence, 0);
  });

  it("handles text with no date and no model", () => {
    const parsed = parseTask("  buy milk  ", { now: MONDAY });
    assert.deepEqual(
      { title: parsed.title, due: parsed.due, bucket: parsed.bucket },
      { title: "buy milk", due: null, bucket: null },
    );
  });
});
