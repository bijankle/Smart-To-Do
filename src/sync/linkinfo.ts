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

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  ratings_average?: number;
  key?: string; // "/works/OL82563W"
}

/**
 * Book info from Open Library (CORS-enabled, keyless — unlike Google Books,
 * which blocks browser requests). Search gives author/year/pages/rating; a
 * second call to the work fetches the description (synopsis).
 */
async function fetchBookInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const query = link.slugTitle;
  if (!query) return null;
  const url =
    "https://openlibrary.org/search.json?limit=5&fields=title,author_name," +
    "first_publish_year,number_of_pages_median,ratings_average,key&q=" +
    encodeURIComponent(query);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const docs = ((await response.json()) as { docs?: OpenLibraryDoc[] }).docs ?? [];
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

  // Second call: the work's description is the synopsis.
  if (doc.key) {
    try {
      const workRes = await fetchFn(`https://openlibrary.org${doc.key}.json`);
      if (workRes.ok) {
        const work = (await workRes.json()) as { description?: string | { value?: string } };
        const desc = typeof work.description === "string" ? work.description : work.description?.value;
        const synopsis = trimSynopsis(desc);
        if (synopsis) info["Synopsis"] = synopsis;
      }
    } catch {
      /* description is a bonus — keep the rest */
    }
  }
  return { title: doc.title ?? titleCase(query), info };
}

/** Wikipedia REST summary (CORS-enabled) → synopsis + canonical title. */
async function wikipediaSummary(pageTitle: string, fetchFn: typeof fetch): Promise<{ title: string; extract: string } | null> {
  const slug = encodeURIComponent(pageTitle.trim().replace(/\s+/g, "_"));
  const response = await fetchFn(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`);
  if (!response.ok) return null;
  const d = (await response.json()) as { title?: string; extract?: string; type?: string };
  if (!d.extract || d.type === "disambiguation") return null;
  return { title: d.title ?? pageTitle, extract: d.extract };
}

interface FilmFacts {
  title: string;
  director: string | null;
  year: string | null;
  durationMin: number | null;
  genre: string | null;
  wikiTitle: string | null;
}

/** Film facts from Wikidata (CORS-enabled) by IMDb id or by title. */
async function wikidataFilm(link: MediaLink, fetchFn: typeof fetch): Promise<FilmFacts | null> {
  const where = link.id
    ? `?film wdt:P345 "${link.id}".`
    : `?film rdfs:label ${JSON.stringify(link.slugTitle ?? "")}@en. ?film wdt:P31/wdt:P279* wd:Q11424.`;
  const sparql =
    `SELECT ?filmLabel ?directorLabel ?date ?duration ?genreLabel ?article WHERE { ${where} ` +
    `OPTIONAL { ?film wdt:P57 ?director. } OPTIONAL { ?film wdt:P577 ?date. } ` +
    `OPTIONAL { ?film wdt:P2047 ?duration. } OPTIONAL { ?film wdt:P136 ?genre. } ` +
    `OPTIONAL { ?article schema:about ?film; schema:isPartOf <https://en.wikipedia.org/>. } ` +
    `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 20`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const rows =
    ((await response.json()) as {
      results?: {
        bindings?: Array<{
          filmLabel?: { value: string };
          directorLabel?: { value: string };
          date?: { value: string };
          duration?: { value: string };
          genreLabel?: { value: string };
          article?: { value: string };
        }>;
      };
    }).results?.bindings ?? [];
  if (rows.length === 0 || !rows[0]!.filmLabel?.value) return null;

  const distinct = (vs: Array<string | undefined>) => [...new Set(vs.filter((v): v is string => Boolean(v)))];
  const article = rows.find((r) => r.article?.value)?.article?.value;
  return {
    title: rows[0]!.filmLabel!.value,
    director: distinct(rows.map((r) => r.directorLabel?.value)).slice(0, 2).join(", ") || null,
    year: rows.find((r) => r.date?.value)?.date?.value?.slice(0, 4) ?? null,
    durationMin: rows.find((r) => r.duration?.value)?.duration?.value
      ? Math.round(parseFloat(rows.find((r) => r.duration?.value)!.duration!.value))
      : null,
    genre: distinct(rows.map((r) => r.genreLabel?.value)).slice(0, 2).join(", ") || null,
    wikiTitle: article ? decodeURIComponent(article.split("/wiki/")[1] ?? "").replace(/_/g, " ") : null,
  };
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
  // Keyless, all CORS-enabled: Wikidata facts + Wikipedia synopsis.
  const facts = await wikidataFilm(link, fetchFn);
  const title = facts?.title ?? link.slugTitle;
  if (!title) return null;
  const info: Record<string, string> = {};
  const wiki = await wikipediaSummary(facts?.wikiTitle ?? title, fetchFn);
  const synopsis = trimSynopsis(wiki?.extract);
  if (synopsis) info["Synopsis"] = synopsis;
  if (facts?.director) info["Director"] = facts.director;
  const year = facts?.year ?? link.year;
  if (year) info["Year"] = year;
  const duration = formatDuration(undefined, facts?.durationMin ? `${facts.durationMin}` : undefined);
  if (duration) info["Duration"] = duration;
  if (facts?.genre) info["Genre"] = facts.genre;
  if (Object.keys(info).length === 0) return null;
  return { title: wiki?.title ?? title, info };
}

/** Spotify oEmbed (keyless, CORS) resolves a bare track/album/artist URL to a name. */
async function nameFromSpotify(url: string, fetchFn: typeof fetch): Promise<string | null> {
  const endpoint = "https://open.spotify.com/oembed?url=" + encodeURIComponent(url);
  const response = await fetchFn(endpoint);
  if (!response.ok) return null;
  const data = (await response.json()) as { title?: string };
  return data.title?.trim() || null;
}

interface MbArtistCredit { name?: string }
interface MbRelease { title?: string; date?: string }
interface MbRecording {
  title?: string;
  length?: number;
  "artist-credit"?: MbArtistCredit[];
  "first-release-date"?: string;
  releases?: MbRelease[];
}
interface MbReleaseGroup {
  title?: string;
  "artist-credit"?: MbArtistCredit[];
  "first-release-date"?: string;
  "primary-type"?: string;
}
interface MbArtist { name?: string; type?: string; country?: string; disambiguation?: string }
interface MbRelation {
  recording?: MbRecording & { id?: string };
  "release-group"?: MbReleaseGroup & { id?: string };
  release?: MbRelease & { id?: string; "release-group"?: MbReleaseGroup };
  artist?: MbArtist & { id?: string };
}

const MB = "https://musicbrainz.org/ws/2";

function songInfo(rec: MbRecording): LinkInfo {
  const info: Record<string, string> = { Type: "Song" };
  const artist = rec["artist-credit"]?.map((c) => c.name).filter(Boolean).join(", ");
  if (artist) info["Artist"] = artist;
  const album = rec.releases?.find((r) => r.title)?.title;
  if (album) info["Album"] = album;
  const year = rec["first-release-date"]?.slice(0, 4) ?? rec.releases?.[0]?.date?.slice(0, 4);
  if (year) info["Released"] = year;
  const length = formatTrackLength(rec.length);
  if (length) info["Length"] = length;
  return { title: rec.title ?? "", info };
}

/**
 * Resolve a Spotify link to the EXACT MusicBrainz entity via its stored URL
 * relationship — a fuzzy title search alone picks the wrong "Sunsets".
 */
async function musicBySpotifyUrl(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const entity = link.entity ?? "track";
  const inc = entity === "artist" ? "artist-rels" : entity === "album" ? "release-rels+release-group-rels" : "recording-rels";
  const r = await fetchFn(`${MB}/url?resource=${encodeURIComponent(link.url)}&inc=${inc}&fmt=json`);
  if (!r.ok) return null;
  const relations = ((await r.json()) as { relations?: MbRelation[] }).relations ?? [];

  if (entity === "artist") {
    const a = relations.find((x) => x.artist)?.artist;
    if (!a?.name) return null;
    const info: Record<string, string> = { Type: "Artist" };
    if (a.disambiguation) info["About"] = a.disambiguation;
    if (a.country) info["Country"] = a.country;
    return { title: a.name, info };
  }
  if (entity === "album") {
    const rg = relations.find((x) => x["release-group"])?.["release-group"];
    const rel = relations.find((x) => x.release)?.release;
    const group = rg ?? rel?.["release-group"];
    const title = group?.title ?? rel?.title;
    if (!title) return null;
    const info: Record<string, string> = { Type: "Album" };
    const artist = group?.["artist-credit"]?.map((c) => c.name).filter(Boolean).join(", ");
    if (artist) info["Artist"] = artist;
    const year = group?.["first-release-date"]?.slice(0, 4) ?? rel?.date?.slice(0, 4);
    if (year) info["Released"] = year;
    return { title, info };
  }
  // Track: the relation carries the recording id; fetch full detail for it.
  const recStub = relations.find((x) => x.recording)?.recording;
  if (!recStub?.id) return recStub?.title ? songInfo(recStub) : null;
  const detail = await fetchFn(`${MB}/recording/${recStub.id}?inc=artist-credits+releases&fmt=json`);
  if (!detail.ok) return recStub.title ? songInfo(recStub) : null;
  return songInfo((await detail.json()) as MbRecording);
}

interface OdesliEntity {
  type?: string; // "song" | "album"
  title?: string;
  artistName?: string;
}

/**
 * Odesli / song.link (CORS-enabled, keyless): turns a Spotify URL into the
 * EXACT title + artist — the reliable way to know "Sunsets" is Powderfinger's,
 * which neither the oEmbed (title only) nor a name search can tell us.
 */
async function odesliEntity(url: string, fetchFn: typeof fetch): Promise<OdesliEntity | null> {
  const endpoint = "https://api.song.link/v1-alpha.1/links?userCountry=AU&url=" + encodeURIComponent(url);
  const r = await fetchFn(endpoint);
  if (!r.ok) return null;
  const data = (await r.json()) as {
    entityUniqueId?: string;
    entitiesByUniqueId?: Record<string, OdesliEntity>;
  };
  const main = data.entityUniqueId ? data.entitiesByUniqueId?.[data.entityUniqueId] : undefined;
  return main?.title ? main : null;
}

/** MusicBrainz recording matched precisely by title AND artist. */
async function mbRecordingByTitleArtist(title: string, artist: string, fetchFn: typeof fetch): Promise<MbRecording | null> {
  const q = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
  const r = await fetchFn(`${MB}/recording?query=${q}&fmt=json&limit=5`);
  if (!r.ok) return null;
  const recs = ((await r.json()) as { recordings?: MbRecording[] }).recordings ?? [];
  const t = normalize(title);
  const a = normalize(artist);
  return (
    recs.find(
      (x) =>
        normalize(x.title) === t &&
        x["artist-credit"]?.some((c) => {
          const n = normalize(c.name);
          return n.includes(a) || a.includes(n);
        }),
    ) ?? recs[0] ?? null
  );
}

/** Music info. Odesli resolves Spotify links to the exact title+artist. */
async function fetchMusicInfo(link: MediaLink, fetchFn: typeof fetch): Promise<LinkInfo | null> {
  const entity = link.entity ?? "track";

  // Spotify link → Odesli for the exact title + artist, then MusicBrainz for
  // album/length/year (now a precise title+artist match, not a guess).
  if (link.url && /open\.spotify\.com/.test(link.url) && entity !== "artist") {
    const od = await odesliEntity(link.url, fetchFn);
    if (od?.title) {
      const info: Record<string, string> = { Type: od.type === "album" ? "Album" : "Song" };
      if (od.artistName) info["Artist"] = od.artistName;
      if (od.type !== "album" && od.artistName) {
        const rec = await mbRecordingByTitleArtist(od.title, od.artistName, fetchFn);
        if (rec) {
          const album = rec.releases?.find((r) => r.title)?.title;
          if (album) info["Album"] = album;
          const year = rec["first-release-date"]?.slice(0, 4) ?? rec.releases?.[0]?.date?.slice(0, 4);
          if (year) info["Released"] = year;
          const length = formatTrackLength(rec.length);
          if (length) info["Length"] = length;
        }
      }
      return { title: od.title, info };
    }
  }

  // Fallback: resolve the exact entity by its Spotify URL relationship in MB.
  if (link.url && /open\.spotify\.com/.test(link.url)) {
    const exact = await musicBySpotifyUrl(link, fetchFn);
    if (exact) return exact;
  }

  // Fallback: search by name (share text, or when the URL isn't in MusicBrainz).
  let query = link.slugTitle;
  if (!query && link.url) query = await nameFromSpotify(link.url, fetchFn);
  if (!query) return null;
  const term = encodeURIComponent(query);
  const target = normalize(query);

  if (entity === "artist") {
    const r = await fetchFn(`${MB}/artist?query=${term}&fmt=json&limit=5`);
    if (!r.ok) return null;
    const list = ((await r.json()) as { artists?: MbArtist[] }).artists ?? [];
    const a = list.find((x) => normalize(x.name) === target) ?? list[0];
    if (!a?.name) return null;
    const info: Record<string, string> = { Type: "Artist" };
    if (a.disambiguation) info["About"] = a.disambiguation;
    if (a.country) info["Country"] = a.country;
    return { title: a.name, info };
  }
  if (entity === "album") {
    const r = await fetchFn(`${MB}/release-group?query=${term}&fmt=json&limit=5`);
    if (!r.ok) return null;
    const list = ((await r.json()) as { "release-groups"?: MbReleaseGroup[] })["release-groups"] ?? [];
    const g = list.find((x) => normalize(x.title) === target) ?? list[0];
    if (!g?.title) return null;
    const info: Record<string, string> = { Type: "Album" };
    const artist = g["artist-credit"]?.map((c) => c.name).filter(Boolean).join(", ");
    if (artist) info["Artist"] = artist;
    if (g["first-release-date"]) info["Released"] = g["first-release-date"].slice(0, 4);
    return { title: g.title, info };
  }
  const r = await fetchFn(`${MB}/recording?query=${term}&fmt=json&limit=8`);
  if (!r.ok) return null;
  const list = ((await r.json()) as { recordings?: MbRecording[] }).recordings ?? [];
  const rec = list.find((x) => normalize(x.title) === target) ?? list[0];
  if (!rec?.title) return null;
  return songInfo(rec);
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
