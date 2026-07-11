/**
 * Pasted-link enrichment: Goodreads → Books, IMDb → Films.
 *
 * Browsers can't read those sites directly (CORS), so key info comes from
 * open, keyless, CORS-friendly databases instead:
 *  - Books: Open Library search, using the title embedded in Goodreads URLs.
 *  - Films: Wikidata, which indexes every IMDb title id (tt...).
 * Everything fails soft — a task is still created from the link itself.
 */

export interface MediaLink {
  /**
   * goodreads/imdb: a real site URL (id known). *-share: share-sheet text
   * like "The Matrix (1999) - IMDb https://share.google/..." where the title
   * lives in the text and the URL is a shortener. link: any other URL.
   */
  kind: "goodreads" | "imdb" | "imdb-share" | "goodreads-share" | "link";
  url: string;
  id: string | null;
  /** Title recovered from the URL slug or the share text, when present. */
  slugTitle: string | null;
  year: string | null;
}

const URL_PATTERN = /https?:\/\/\S+/gi;

export function parseMediaLink(text: string): MediaLink | null {
  const goodreads = /https?:\/\/(?:www\.)?goodreads\.com\/book\/show\/(\d+)(?:[-.]([\w~%-]+))?/i.exec(text);
  if (goodreads) {
    const slug = goodreads[2]
      ? decodeURIComponent(goodreads[2]).replace(/[-_]+/g, " ").trim()
      : null;
    return { kind: "goodreads", url: goodreads[0], id: goodreads[1]!, slugTitle: slug || null, year: null };
  }
  const imdb = /https?:\/\/(?:www\.|m\.)?imdb\.com\/title\/(tt\d+)/i.exec(text);
  if (imdb) {
    return { kind: "imdb", url: imdb[0], id: imdb[1]!, slugTitle: null, year: null };
  }

  const anyUrl = new RegExp(URL_PATTERN).exec(text);
  const url = anyUrl ? anyUrl[0] : null;
  const textPart = text.replace(new RegExp(URL_PATTERN), " ").replace(/\s+/g, " ").trim();

  // Signal-first: the mere presence of "IMDb" / "Goodreads" (in the text OR
  // the URL) settles the category — a film is a film even if we can't parse a
  // clean title. Title extraction below is a best-effort bonus.
  const haystack = `${textPart} ${url ?? ""}`;
  const isImdb = /\bimdb\b/i.test(haystack);
  const isGoodreads = /\bgoodreads\b/i.test(haystack);
  if (!isImdb && !isGoodreads) {
    if (!url) return null;
    return { kind: "link", url, id: null, slugTitle: textPart || null, year: null };
  }

  const year = /\((\d{4})\)/.exec(textPart)?.[1] ?? null;
  // Strip the trailing source tag, year, and connector words to recover the title.
  const title =
    textPart
      .replace(/[\s(]*\d{4}[\s)]*/, " ")
      .replace(/\s*[-–—|:]\s*(imdb|goodreads).*$/i, "")
      .replace(/\b(imdb|goodreads)\b/gi, "")
      .replace(/\s*[-–—|:]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(on|via|at|from|see|check|watch)$/i, "")
      .replace(/^(on|via|at|from|see|check|watch)\s+/i, "")
      .trim() || null;

  if (isImdb) {
    return { kind: "imdb-share", url: url ?? "", id: null, slugTitle: title, year };
  }
  return { kind: "goodreads-share", url: url ?? "", id: null, slugTitle: title, year: null };
}

export function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface LinkInfo {
  title: string;
  info: Record<string, string>;
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  ratings_average?: number;
}

async function fetchBookInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const query = link.slugTitle;
  if (!query) return null;
  const url =
    "https://openlibrary.org/search.json?limit=5" +
    "&fields=title,author_name,first_publish_year,number_of_pages_median,ratings_average" +
    "&q=" + encodeURIComponent(query);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { docs?: OpenLibraryDoc[] };
  const docs = data.docs ?? [];
  const target = normalize(query);
  const doc =
    docs.find((d) => {
      const t = normalize(d.title);
      return t.length > 0 && (target.includes(t) || t.includes(target));
    }) ?? docs[0];
  if (!doc) return null;

  const info: Record<string, string> = {};
  if (doc.author_name?.length) info["Author"] = doc.author_name.slice(0, 2).join(", ");
  if (doc.first_publish_year) info["Published"] = String(doc.first_publish_year);
  if (doc.number_of_pages_median) info["Pages"] = String(doc.number_of_pages_median);
  if (doc.ratings_average) info["Rating"] = `${doc.ratings_average.toFixed(1)} / 5`;
  return { title: doc.title ?? titleCase(query), info };
}

interface SparqlBinding {
  filmLabel?: { value: string };
  directorLabel?: { value: string };
  date?: { value: string };
  genreLabel?: { value: string };
}

async function fetchFilmInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const sparql =
    `SELECT ?filmLabel ?directorLabel ?date ?genreLabel WHERE { ` +
    `?film wdt:P345 "${link.id}". ` +
    `OPTIONAL { ?film wdt:P57 ?director. } ` +
    `OPTIONAL { ?film wdt:P577 ?date. } ` +
    `OPTIONAL { ?film wdt:P136 ?genre. } ` +
    `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 8`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { results?: { bindings?: SparqlBinding[] } };
  const rows = data.results?.bindings ?? [];
  const title = rows[0]?.filmLabel?.value;
  if (!title) return null;

  const distinct = (values: Array<string | undefined>) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))];
  const info: Record<string, string> = {};
  const directors = distinct(rows.map((r) => r.directorLabel?.value)).slice(0, 2);
  if (directors.length) info["Director"] = directors.join(", ");
  const year = rows[0]?.date?.value?.slice(0, 4);
  if (year) info["Year"] = year;
  const genres = distinct(rows.map((r) => r.genreLabel?.value)).slice(0, 2);
  if (genres.length) info["Genre"] = genres.join(", ");
  return { title, info };
}

interface ItunesMovie {
  kind?: string;
  trackName?: string;
  artistName?: string;
  releaseDate?: string;
  primaryGenreName?: string;
}

/** Share-text films carry a title, not an id — resolve via iTunes movie search. */
async function fetchFilmByTitle(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const title = link.slugTitle;
  if (!title) return null;
  const url =
    "https://itunes.apple.com/search?media=movie&limit=8&country=AU&term=" +
    encodeURIComponent(title);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { results?: ItunesMovie[] };
  const target = normalize(title);
  const candidates = (data.results ?? []).filter(
    (r) => r.kind === "feature-movie" && normalize(r.trackName) === target,
  );
  const match = candidates.find((r) => link.year && r.releaseDate?.startsWith(link.year)) ?? candidates[0];
  if (!match) return null;
  const info: Record<string, string> = {};
  if (match.artistName) info["Director"] = match.artistName;
  const year = match.releaseDate?.slice(0, 4) ?? link.year;
  if (year) info["Year"] = year;
  if (match.primaryGenreName) info["Genre"] = match.primaryGenreName;
  return { title: match.trackName ?? title, info };
}

export async function fetchLinkInfo(
  link: MediaLink,
  fetchFn: typeof fetch = fetch,
): Promise<LinkInfo | null> {
  try {
    switch (link.kind) {
      case "goodreads":
      case "goodreads-share":
        return await fetchBookInfo(link, fetchFn);
      case "imdb":
        return await fetchFilmInfo(link, fetchFn);
      case "imdb-share":
        return await fetchFilmByTitle(link, fetchFn);
      default:
        return null;
    }
  } catch {
    return null; // offline — the task keeps its slug title and link
  }
}
