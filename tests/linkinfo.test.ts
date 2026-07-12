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

  it("enriches a Goodreads link from Open Library (synopsis, pages, rating)", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("/search.json")) {
        return { ok: true, json: async () => ({ docs: [
          { title: "Project Hail Mary", author_name: ["Andy Weir"], first_publish_year: 2021,
            number_of_pages_median: 476, ratings_average: 4.5, key: "/works/OL20853433W" },
        ] }) } as Response;
      }
      // Work detail → description (synopsis).
      return { ok: true, json: async () => ({
        description: "Ryland Grace is the sole survivor on a desperate mission. If he fails, humanity and Earth itself will perish. Except he can't remember why he's there.",
      }) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("https://goodreads.com/book/show/54493401-project-hail-mary")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "Project Hail Mary");
    assert.equal(result?.info["Author"], "Andy Weir");
    assert.equal(result?.info["Published"], "2021");
    assert.equal(result?.info["Pages"], "476");
    assert.equal(result?.info["Rating"], "4.5 / 5");
    assert.ok(result?.info["Synopsis"]?.includes("Ryland Grace"));
  });

  it("reads the synopsis from an Open Library description object", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("/search.json")) {
        return { ok: true, json: async () => ({ docs: [
          { title: "Harry Potter and the Chamber of Secrets", author_name: ["J.K. Rowling"],
            number_of_pages_median: 341, ratings_average: 4.4, key: "/works/OL82586W" },
        ] }) } as Response;
      }
      // Open Library sometimes returns description as { type, value }.
      return { ok: true, json: async () => ({
        description: { type: "/type/text", value: "Harry returns to Hogwarts for a second year, only for a dark force to petrify students." },
      }) } as Response;
    }) as unknown as typeof fetch;
    const link = parseMediaLink("https://goodreads.com/book/show/15881-harry-potter-and-the-chamber-of-secrets")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.ok(result?.info["Synopsis"]?.includes("Hogwarts"));
    assert.equal(result?.info["Author"], "J.K. Rowling");
    assert.equal(result?.info["Pages"], "341");
  });

  it("enriches a bare IMDb link keyless: Wikidata facts + Wikipedia synopsis", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("wikidata")) {
        return { ok: true, json: async () => ({ results: { bindings: [{
          filmLabel: { value: "Oppenheimer" }, directorLabel: { value: "Christopher Nolan" },
          date: { value: "2023-07-21T00:00:00Z" }, duration: { value: "180" },
          genreLabel: { value: "biographical film" },
          article: { value: "https://en.wikipedia.org/wiki/Oppenheimer_(film)" } }] } }) } as Response;
      }
      // Wikipedia REST summary
      return { ok: true, json: async () => ({ title: "Oppenheimer",
        extract: "Oppenheimer is a 2023 epic biographical thriller film about J. Robert Oppenheimer.", type: "standard" }) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("https://www.imdb.com/title/tt15398776/")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "Oppenheimer");
    assert.equal(result?.info["Director"], "Christopher Nolan");
    assert.equal(result?.info["Year"], "2023");
    assert.equal(result?.info["Duration"], "3h 0m");
    assert.ok(result?.info["Synopsis"]?.includes("Oppenheimer"));
  });

  it("uses OMDb for the IMDb rating /10 when a key is supplied", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      assert.ok(String(input).includes("omdbapi.com"));
      return { ok: true, json: async () => ({
        Response: "True", Title: "The Matrix", Year: "1999", Runtime: "136 min",
        Genre: "Action, Sci-Fi", Director: "The Wachowskis",
        Plot: "A hacker learns reality is a simulation.", imdbRating: "8.7",
      }) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("The Matrix (1999) - IMDb https://share.google/x")!;
    const result = await fetchLinkInfo(link, fakeFetch, "testkey");
    assert.equal(result?.info["Rating"], "8.7 / 10");
    assert.equal(result?.info["Duration"], "2h 16m");
    assert.ok(result?.info["Synopsis"]?.includes("hacker"));
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

  it("enriches a share-text film keyless via Wikidata + Wikipedia", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("wikidata")) {
        return { ok: true, json: async () => ({ results: { bindings: [{
          filmLabel: { value: "The Matrix" }, directorLabel: { value: "The Wachowskis" },
          date: { value: "1999-03-31T00:00:00Z" }, duration: { value: "136" },
          genreLabel: { value: "science fiction film" },
          article: { value: "https://en.wikipedia.org/wiki/The_Matrix" } }] } }) } as Response;
      }
      return { ok: true, json: async () => ({ title: "The Matrix",
        extract: "The Matrix is a 1999 science fiction film in which a computer hacker learns the true nature of reality.", type: "standard" }) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("The Matrix (1999) - IMDb https://share.google/xyz")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "The Matrix");
    assert.equal(result?.info["Year"], "1999");
    assert.equal(result?.info["Duration"], "2h 16m");
    assert.ok(result?.info["Synopsis"]?.includes("hacker"));
  });

  it("recognizes Spotify links and share text (track/album/artist)", () => {
    const track = parseMediaLink("https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6");
    assert.equal(track?.kind, "spotify");
    assert.equal(track?.entity, "track");
    assert.equal(track?.id, "6rqhFgbbKwnb9MLmUQDhG6");

    const album = parseMediaLink("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv");
    assert.equal(album?.entity, "album");
    const artist = parseMediaLink("https://open.spotify.com/artist/0oSGxfWSnnOXhD2fKuz2Gy");
    assert.equal(artist?.entity, "artist");

    // Share text with a shortener still bins to music off the word 'Spotify'.
    const share = parseMediaLink("Bohemian Rhapsody · Queen | Spotify https://spotify.link/abc");
    assert.equal(share?.kind, "spotify-share");
    assert.ok(/bohemian rhapsody/i.test(share!.slugTitle ?? ""));
  });

  it("resolves the EXACT Spotify track via Odesli, then MusicBrainz by title+artist", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("song.link")) {
        // Odesli gives the exact title + artist from the Spotify URL.
        return { ok: true, json: async () => ({
          entityUniqueId: "SPOTIFY_SONG::1dXFZeIjgDJ8sAc1csFNY2",
          entitiesByUniqueId: { "SPOTIFY_SONG::1dXFZeIjgDJ8sAc1csFNY2": {
            type: "song", title: "Sunsets", artistName: "Powderfinger" } },
        }) } as Response;
      }
      if (u.includes("/recording?query=")) {
        // Precise title+artist match fills in album/year/length.
        return { ok: true, json: async () => ({ recordings: [{ title: "Sunsets", length: 287_000,
          "artist-credit": [{ name: "Powderfinger" }], "first-release-date": "2011-01-01",
          releases: [{ title: "Golden Rule", date: "2011" }] }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("https://open.spotify.com/track/1dXFZeIjgDJ8sAc1csFNY2")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "Sunsets");
    assert.equal(result?.info["Artist"], "Powderfinger");
    assert.equal(result?.info["Album"], "Golden Rule");
    assert.equal(result?.info["Length"], "4:47");
  });

  it("resolves a Spotify album via Odesli", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("song.link")) {
        return { ok: true, json: async () => ({
          entityUniqueId: "SPOTIFY_ALBUM::4LH4d3cOWNNsVw41Gqt2kv",
          entitiesByUniqueId: { "SPOTIFY_ALBUM::4LH4d3cOWNNsVw41Gqt2kv": {
            type: "album", title: "A Night at the Opera", artistName: "Queen" } },
        }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.title, "A Night at the Opera");
    assert.equal(result?.info["Artist"], "Queen");
    assert.equal(result?.info["Type"], "Album");
  });

  it("falls back to the MusicBrainz Spotify-URL lookup when Odesli is down", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("song.link")) return { ok: false, json: async () => ({}) } as Response;
      if (u.includes("/url?resource=")) {
        return { ok: true, json: async () => ({ relations: [{ recording: { id: "rec-123", title: "Sunsets" } }] }) } as Response;
      }
      if (u.includes("/recording/rec-123")) {
        return { ok: true, json: async () => ({ title: "Sunsets", length: 287_000,
          "artist-credit": [{ name: "Powderfinger" }], "first-release-date": "2011-01-01",
          releases: [{ title: "Golden Rule", date: "2011" }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const link = parseMediaLink("https://open.spotify.com/track/1dXFZeIjgDJ8sAc1csFNY2")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.info["Artist"], "Powderfinger");
    assert.equal(result?.info["Length"], "4:47");
  });

  it("share-text music (no Spotify URL) falls back to a name search", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("/recording?query=")) {
        return { ok: true, json: async () => ({ recordings: [{ title: "Sunsets",
          "artist-credit": [{ name: "Powderfinger" }], "first-release-date": "2011",
          releases: [{ title: "Golden Rule" }] }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const link = parseMediaLink("Sunsets by Powderfinger | Spotify https://spotify.link/x")!;
    const result = await fetchLinkInfo(link, fakeFetch);
    assert.equal(result?.info["Artist"], "Powderfinger");
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
