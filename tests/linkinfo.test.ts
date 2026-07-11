import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchLinkInfo, parseMediaLink, titleCase } from "../src/sync/linkinfo.js";
import { Repository } from "../src/storage/repo.js";
import { MemoryPersistence } from "../src/storage/persistence.js";

describe("Pasted media links", () => {
  it("parses Goodreads and IMDb URLs out of surrounding text", () => {
    const gr = parseMediaLink(
      "check this out https://www.goodreads.com/book/show/54493401-project-hail-mary?ref=x",
    );
    assert.equal(gr?.kind, "goodreads");
    assert.equal(gr?.id, "54493401");
    assert.equal(gr?.slugTitle, "project hail mary");

    const imdb = parseMediaLink("https://m.imdb.com/title/tt15398776/");
    assert.equal(imdb?.kind, "imdb");
    assert.equal(imdb?.id, "tt15398776");

    assert.equal(parseMediaLink("buy milk and bread"), null);
    assert.equal(titleCase("project hail mary"), "Project Hail Mary");
  });

  it("enriches a Goodreads link from Open Library", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        docs: [
          {
            title: "Project Hail Mary",
            author_name: ["Andy Weir"],
            first_publish_year: 2021,
            number_of_pages_median: 476,
            ratings_average: 4.5,
          },
        ],
      }),
    })) as unknown as typeof fetch;

    const link = parseMediaLink("https://goodreads.com/book/show/54493401-project-hail-mary")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "Project Hail Mary");
    assert.equal(result?.info["Author"], "Andy Weir");
    assert.equal(result?.info["Published"], "2021");
    assert.equal(result?.info["Rating"], "4.5 / 5");
  });

  it("enriches an IMDb link from Wikidata", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        results: {
          bindings: [
            {
              filmLabel: { value: "Oppenheimer" },
              directorLabel: { value: "Christopher Nolan" },
              date: { value: "2023-07-21T00:00:00Z" },
              genreLabel: { value: "biographical film" },
            },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const link = parseMediaLink("https://www.imdb.com/title/tt15398776/")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "Oppenheimer");
    assert.equal(result?.info["Director"], "Christopher Nolan");
    assert.equal(result?.info["Year"], "2023");
  });

  it("fails soft when offline", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const link = parseMediaLink("https://www.imdb.com/title/tt15398776/")!;
    assert.equal(await fetchLinkInfo(link, failing), null);
  });

  it("addLinkedTask + attachInfo persist link, info, and bucket", async () => {
    const persistence = new MemoryPersistence();
    let tick = 0;
    const repo = await Repository.open(persistence, {
      now: () => new Date(1_000_000 + ++tick * 1000),
      newId: () => `task-${tick}`,
    });
    repo.createBucket("Books");
    const task = repo.addLinkedTask(
      "Project Hail Mary",
      ["Books", "NoSuchBucket"],
      "https://goodreads.com/book/show/54493401",
      {},
    );
    assert.deepEqual(task.buckets, ["Books"]);
    repo.attachInfo(task.id, { info: { Author: "Andy Weir" } });
    await repo.flush();

    const reopened = await Repository.open(persistence, {});
    const restored = reopened.getTask(task.id)!;
    assert.equal(restored.link, "https://goodreads.com/book/show/54493401");
    assert.equal(restored.info?.["Author"], "Andy Weir");
    assert.deepEqual(restored.buckets, ["Books"]);
  });
});
