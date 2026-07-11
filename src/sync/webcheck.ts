/**
 * Background reference check — the "is this a song / film / book?" pass.
 *
 * No local library can hold every artist, film, and book title, so untagged
 * captures get checked against Apple's iTunes Search catalogue: free,
 * keyless, CORS-enabled, and one query covers music, movies, and books.
 * Results only ever SUGGEST tags for tasks the user hasn't touched — they
 * never override manual tagging, and everything fails silently offline.
 */

export type MediaConcept = "music" | "films" | "books";

interface ItunesResult {
  kind?: string;
  wrapperType?: string;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Strip capture verbs so "listen to bicep" searches for "bicep". */
function searchTerm(title: string): string {
  return title
    .trim()
    .replace(/^(listen to|listen|watch|read|play)\s+/i, "")
    .replace(/^(the movie|the film|the album|the book)\s+/i, "");
}

export function conceptsFromResults(term: string, results: ItunesResult[]): MediaConcept[] {
  const target = normalize(term);
  if (!target) return [];
  const concepts = new Set<MediaConcept>();
  for (const result of results) {
    // Require an exact (normalized) name match — iTunes search is fuzzy and
    // will happily return songs for "fix the fence" otherwise.
    const names = [result.trackName, result.collectionName, result.artistName].map(normalize);
    if (!names.includes(target)) continue;
    const kind = result.kind ?? "";
    if (result.wrapperType === "artist" || /^(song|album|music)/.test(kind)) concepts.add("music");
    if (/^feature-movie|^tv-/.test(kind)) concepts.add("films");
    if (/book/.test(kind)) concepts.add("books");
  }
  return [...concepts];
}

export async function lookupMediaConcepts(
  title: string,
  fetchFn: typeof fetch = fetch,
): Promise<MediaConcept[]> {
  const term = searchTerm(title);
  if (term.length < 2) return [];
  const url =
    "https://itunes.apple.com/search?media=all&limit=12&country=AU&term=" +
    encodeURIComponent(term);
  try {
    const response = await fetchFn(url);
    if (!response.ok) return [];
    const data = (await response.json()) as { results?: ItunesResult[] };
    return conceptsFromResults(term, data.results ?? []);
  } catch {
    return []; // offline or blocked — the local lexicon remains the authority
  }
}
