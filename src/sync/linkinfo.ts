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
  kind: "goodreads" | "imdb" | "imdb-share" | "goodreads-share" | "spotify" | "spotify-share" | "link";
  url: string;
  id: string | null;
  /** Title recovered from the URL slug or the share text, when present. */
  slugTitle: string | null;
  year: string | null;
  /** Spotify entity type, when known from the URL. */
  entity?: "track" | "album" | "artist";
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
  const spotify = /https?:\/\/open\.spotify\.com\/(track|album|artist)\/([A-Za-z0-9]+)/i.exec(text);
  if (spotify) {
    return {
      kind: "spotify",
      url: spotify[0],
      id: spotify[2]!,
      slugTitle: null,
      year: null,
      entity: spotify[1]!.toLowerCase() as "track" | "album" | "artist",
    };
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
  const isSpotify = /\bspotify\b/i.test(haystack);
  if (!isImdb && !isGoodreads && !isSpotify) {
    if (!url) return null;
    return { kind: "link", url, id: null, slugTitle: textPart || null, year: null };
  }

  const year = /\((\d{4})\)/.exec(textPart)?.[1] ?? null;
  // Strip the trailing source tag, year, and connector words to recover the title.
  const title =
    textPart
      .replace(/[\s(]*\d{4}[\s)]*/, " ")
      .replace(/\s*[-–—|:]\s*(imdb|goodreads|spotify).*$/i, "")
      .replace(/\bsong by\b/i, "")
      .replace(/\b(imdb|goodreads|spotify)\b/gi, "")
      .replace(/\s*[-–—|:·]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(on|via|at|from|see|check|watch|listen)$/i, "")
      .replace(/^(on|via|at|from|see|check|watch|listen)\s+/i, "")
      .trim() || null;

  if (isImdb) {
    return { kind: "imdb-share", url: url ?? "", id: null, slugTitle: title, year };
  }
  if (isGoodreads) {
    return { kind: "goodreads-share", url: url ?? "", id: null, slugTitle: title, year: null };
  }
  return { kind: "spotify-share", url: url ?? "", id: null, slugTitle: title, year: null };
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

/** Trim a synopsis to one readable sentence-ish chunk for the callout. */
function trimSynopsis(text: string | undefined, max = 260): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd()) + "…";
}

/** Film length. Milliseconds or "N min" → "2h 16m". */
function formatDuration(ms?: number, minutesText?: string): string | null {
  let minutes = ms ? Math.round(ms / 60000) : NaN;
  if (!minutes && minutesText) minutes = parseInt(minutesText, 10);
  if (!minutes || Number.isNaN(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Song length → "5:54" (minutes:seconds). */
function formatTrackLength(ms?: number): string | null {
  if (!ms || ms < 1000) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

interface GoogleBookVolume {
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publishedDate?: string;
    pageCount?: number;
    averageRating?: number;
    categories?: string[];
    description?: string;
  };
}

async function fetchBookInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const query = link.slugTitle;
  if (!query) return null;
  // Google Books is keyless for basic search and carries description + rating.
  const url =
    "https://www.googleapis.com/books/v1/volumes?maxResults=5&country=AU&q=" +
    encodeURIComponent(query);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { items?: GoogleBookVolume[] };
  const items = data.items ?? [];
  const target = normalize(query);
  const pick =
    items.find((it) => {
      const t = normalize(it.volumeInfo?.title);
      return t.length > 0 && (target.includes(t) || t.includes(target));
    }) ?? items[0];
  const v = pick?.volumeInfo;
  if (!v) return null;

  const info: Record<string, string> = {};
  if (v.authors?.length) info["Author"] = v.authors.slice(0, 2).join(", ");
  if (v.publishedDate) info["Published"] = v.publishedDate.slice(0, 4);
  if (v.pageCount) info["Pages"] = String(v.pageCount);
  if (v.averageRating) info["Rating"] = `${v.averageRating.toFixed(1)} / 5`;
  if (v.categories?.length) info["Genre"] = v.categories[0]!;
  const synopsis = trimSynopsis(v.description);
  if (synopsis) info["Synopsis"] = synopsis;
  return { title: v.title ?? titleCase(query), info };
}

/** Resolve a bare IMDb id to a title (+ year) via Wikidata's IMDb index. */
async function titleFromImdbId(id: string, fetchFn: typeof fetch): Promise<{ title: string; year: string | null } | null> {
  const sparql =
    `SELECT ?filmLabel ?date WHERE { ?film wdt:P345 "${id}". ` +
    `OPTIONAL { ?film wdt:P577 ?date. } ` +
    `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as {
    results?: { bindings?: Array<{ filmLabel?: { value: string }; date?: { value: string } }> };
  };
  const row = data.results?.bindings?.[0];
  if (!row?.filmLabel?.value) return null;
  return { title: row.filmLabel.value, year: row.date?.value?.slice(0, 4) ?? null };
}

interface ItunesMovie {
  kind?: string;
  trackName?: string;
  artistName?: string;
  releaseDate?: string;
  primaryGenreName?: string;
  longDescription?: string;
  shortDescription?: string;
  trackTimeMillis?: number;
  contentAdvisoryRating?: string;
}

/** Rich film info from the keyless iTunes movie catalogue, by title. */
async function fetchFilmByTitle(title: string, year: string | null, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const url =
    "https://itunes.apple.com/search?media=movie&limit=10&country=AU&term=" +
    encodeURIComponent(title);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const data = (await response.json()) as { results?: ItunesMovie[] };
  const target = normalize(title);
  const candidates = (data.results ?? []).filter(
    (r) => r.kind === "feature-movie" && normalize(r.trackName) === target,
  );
  const match = candidates.find((r) => year && r.releaseDate?.startsWith(year)) ?? candidates[0];
  if (!match) return null;

  const info: Record<string, string> = {};
  const synopsis = trimSynopsis(match.longDescription ?? match.shortDescription);
  if (synopsis) info["Synopsis"] = synopsis;
  if (match.artistName) info["Director"] = match.artistName;
  const y = match.releaseDate?.slice(0, 4) ?? year;
  if (y) info["Year"] = y;
  const duration = formatDuration(match.trackTimeMillis);
  if (duration) info["Duration"] = duration;
  if (match.primaryGenreName) info["Genre"] = match.primaryGenreName;
  if (match.contentAdvisoryRating) info["Rated"] = match.contentAdvisoryRating;
  return { title: match.trackName ?? title, info };
}

interface OmdbMovie {
  Response?: string;
  Title?: string;
  Year?: string;
  Runtime?: string;
  Genre?: string;
  Director?: string;
  Plot?: string;
  imdbRating?: string;
}

/** Full film info incl. the IMDb rating /10, via OMDb (optional free key). */
async function fetchFilmOmdb(link: MediaLink, key: string, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const params = link.id
    ? `i=${link.id}`
    : `t=${encodeURIComponent(link.slugTitle ?? "")}${link.year ? `&y=${link.year}` : ""}`;
  const url = `https://www.omdbapi.com/?plot=short&apikey=${encodeURIComponent(key)}&${params}`;
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const m = (await response.json()) as OmdbMovie;
  if (m.Response === "False" || !m.Title) return null;

  const info: Record<string, string> = {};
  const synopsis = trimSynopsis(m.Plot);
  if (synopsis) info["Synopsis"] = synopsis;
  if (m.Director && m.Director !== "N/A") info["Director"] = m.Director;
  if (m.Year) info["Year"] = m.Year.replace(/[^\d]/g, "").slice(0, 4);
  const duration = formatDuration(undefined, m.Runtime);
  if (duration) info["Duration"] = duration;
  if (m.Genre && m.Genre !== "N/A") info["Genre"] = m.Genre.split(",").slice(0, 2).join(",").trim();
  if (m.imdbRating && m.imdbRating !== "N/A") info["Rating"] = `${m.imdbRating} / 10`;
  return { title: m.Title, info };
}

async function fetchFilmInfo(link: MediaLink, omdbKey: string | null, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  // With a key, OMDb is richest (incl. IMDb rating /10) for id or title.
  if (omdbKey) {
    const viaOmdb = await fetchFilmOmdb(link, omdbKey, fetchFn);
    if (viaOmdb) return viaOmdb;
  }
  // Keyless: resolve a title (bare imdb id → Wikidata), then iTunes for detail.
  let title = link.slugTitle;
  let year = link.year;
  if (!title && link.id) {
    const resolved = await titleFromImdbId(link.id, fetchFn);
    if (!resolved) return null;
    title = resolved.title;
    year = year ?? resolved.year;
  }
  if (!title) return null;
  return fetchFilmByTitle(title, year, fetchFn);
}

interface ItunesMusic {
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  releaseDate?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
  trackCount?: number;
}

/** Spotify oEmbed (keyless) resolves a bare track/album/artist URL to a name. */
async function nameFromSpotify(url: string, fetchFn: typeof fetch): Promise<string | null> {
  const endpoint = "https://open.spotify.com/oembed?url=" + encodeURIComponent(url);
  const response = await fetchFn(endpoint);
  if (!response.ok) return null;
  const data = (await response.json()) as { title?: string };
  return data.title?.trim() || null;
}

/** Rich music info from the keyless iTunes/Apple Music catalogue. */
async function fetchMusicInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  let query = link.slugTitle;
  if (!query && link.url) query = await nameFromSpotify(link.url, fetchFn);
  if (!query) return null;

  const entity = link.entity ?? "track";
  const entityParam = entity === "album" ? "album" : entity === "artist" ? "musicArtist" : "song";
  const url =
    `https://itunes.apple.com/search?media=music&entity=${entityParam}&limit=12&country=AU&term=` +
    encodeURIComponent(query);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const results = ((await response.json()) as { results?: ItunesMusic[] }).results ?? [];
  const target = normalize(query);

  if (entity === "artist") {
    const m = results.find((r) => normalize(r.artistName) === target) ?? results[0];
    if (!m?.artistName) return null;
    const info: Record<string, string> = { Type: "Artist" };
    if (m.primaryGenreName) info["Genre"] = m.primaryGenreName;
    return { title: m.artistName, info };
  }
  if (entity === "album") {
    const m = results.find((r) => normalize(r.collectionName) === target) ?? results[0];
    if (!m?.collectionName) return null;
    const info: Record<string, string> = { Type: "Album" };
    if (m.artistName) info["Artist"] = m.artistName;
    if (m.releaseDate) info["Released"] = m.releaseDate.slice(0, 4);
    if (m.trackCount) info["Tracks"] = String(m.trackCount);
    if (m.primaryGenreName) info["Genre"] = m.primaryGenreName;
    return { title: m.collectionName, info };
  }
  const m = results.find((r) => normalize(r.trackName) === target) ?? results[0];
  if (!m?.trackName) return null;
  const info: Record<string, string> = { Type: "Song" };
  if (m.artistName) info["Artist"] = m.artistName;
  if (m.collectionName) info["Album"] = m.collectionName;
  if (m.releaseDate) info["Released"] = m.releaseDate.slice(0, 4);
  const length = formatTrackLength(m.trackTimeMillis);
  if (length) info["Length"] = length;
  if (m.primaryGenreName) info["Genre"] = m.primaryGenreName;
  return { title: m.trackName, info };
}

export async function fetchLinkInfo(
  link: MediaLink,
  fetchFn: typeof fetch = fetch,
  omdbKey: string | null = null,
): Promise<LinkInfo | null> {
  try {
    switch (link.kind) {
      case "goodreads":
      case "goodreads-share":
        return await fetchBookInfo(link, fetchFn);
      case "imdb":
      case "imdb-share":
        return await fetchFilmInfo(link, omdbKey, fetchFn);
      case "spotify":
      case "spotify-share":
        return await fetchMusicInfo(link, fetchFn);
      default:
        return null;
    }
  } catch {
    return null; // offline — the task keeps its slug title and link
  }
}
