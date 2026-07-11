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

  it("parses share-sheet text with shortener links (the Google-app share format)", () => {
    const share = parseMediaLink("The Matrix (1999) - IMDb https://share.google/u74UxoQQ19N8EWqyu");
    assert.equal(share?.kind, "imdb-share");
    assert.equal(share?.slugTitle, "The Matrix");
    assert.equal(share?.year, "1999");
    assert.equal(share?.url, "https://share.google/u74UxoQQ19N8EWqyu");

    const grShare = parseMediaLink("Project Hail Mary - Goodreads https://share.google/abc123");
    assert.equal(grShare?.kind, "goodreads-share");
    assert.equal(grShare?.slugTitle, "Project Hail Mary");

    const generic = parseMediaLink("cool recipe https://example.com/pasta");
    assert.equal(generic?.kind, "link");
    assert.equal(generic?.slugTitle, "cool recipe");
  });

  it("recognizes the source even when the title can't be parsed", () => {
    // Bare IMDb link → Films, no title needed.
    const bare = parseMediaLink("https://www.imdb.com/title/tt0133093/");
    assert.equal(bare?.kind, "imdb");

    // Odd share formatting still bins as a film off the word 'IMDb' alone.
    const messy = parseMediaLink("check IMDb https://share.google/xyz");
    assert.equal(messy?.kind, "imdb-share");

    // The word 'imdb' with no URL at all is still a film.
    const noUrl = parseMediaLink("Dune Part Two on imdb");
    assert.equal(noUrl?.kind, "imdb-share");
    assert.equal(noUrl?.slugTitle, "Dune Part Two");

    // Goodreads shortener with reversed order.
    const gr = parseMediaLink("https://share.google/abc via Goodreads");
    assert.equal(gr?.kind, "goodreads-share");
  });

  it("enriches a share-text film by title via the movie catalogue", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        results: [
          { kind: "feature-movie", trackName: "The Matrix", artistName: "Lana Wachowski & Lilly Wachowski", releaseDate: "1999-03-31T00:00:00Z", primaryGenreName: "Sci-Fi & Fantasy" },
          { kind: "feature-movie", trackName: "The Matrix Reloaded", releaseDate: "2003-05-15T00:00:00Z" },
        ],
      }),
    })) as unknown as typeof fetch;

    const link = parseMediaLink("The Matrix (1999) - IMDb https://share.google/xyz")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "The Matrix");
    assert.equal(result?.info["Year"], "1999");
    assert.equal(result?.info["Genre"], "Sci-Fi & Fantasy");
  });

  it("fails soft when offline", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const link = parseMediaLink("https://www.imdb.com/title/tt15398776/")!;
    assert.equal(await fetchLinkInfo(link, failing), null);
  });

  it("relinkMedia heals a plain task that has a share string in its title", async () => {
    let tick = 0;
    const repo = await Repository.open(new MemoryPersistence(), {
      now: () => new Date(1_000_000 + ++tick * 1000),
      newId: () => `task-${tick}`,
    });
    repo.createBucket("Films");
    // Simulate a pre-fix junk task.
    const plain = repo.addTask("The Matrix (1999) - IMDb https://share.google/xyz");
    assert.equal(plain.link, undefined);

    const media = parseMediaLink(plain.title)!;
    repo.relinkMedia(plain.id, media.slugTitle!, repo.bucketsForConceptName("films"), media.url);
    const healed = repo.getTask(plain.id)!;
    assert.equal(healed.title, "The Matrix");
    assert.deepEqual(healed.buckets, ["Films"]);
    assert.equal(healed.link, "https://share.google/xyz");
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
