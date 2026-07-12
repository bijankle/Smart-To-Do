/**
 * Background reference check — "is this untagged text a song / artist?"
 *
 * No local library holds every artist or song, so untagged captures are
 * checked against MusicBrainz (free, keyless, CORS-enabled). Only music is
 * checked here — films and books enter via pasted links, which carry the
 * source. Results only SUGGEST a tag for tasks the user hasn't touched;
 * everything fails silently offline. An exact name match is required so
 * "fix the fence" never becomes a song.
 */

export type MediaConcept = "music" | "films" | "books";

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Strip capture verbs so "listen to bicep" searches for "bicep". */
function searchTerm(title: string): string {
  return title
    .trim()
    .replace(/^(listen to|listen|play|put on)\s+/i, "")
    .replace(/^(the song|the album|the artist|the band)\s+/i, "")
    .trim();
}

interface MbEntity {
  name?: string;
  title?: string;
  score?: number;
}

/** True when MusicBrainz has an exact artist/recording/release named `term`. */
export function isKnownMusic(term: string, artists: MbEntity[], recordings: MbEntity[], releases: MbEntity[]): boolean {
  const target = normalize(term);
  if (target.length < 3) return false;
  const exact = (list: MbEntity[], key: "name" | "title") =>
    list.some((e) => normalize(e[key]) === target && (e.score ?? 0) >= 90);
  return exact(artists, "name") || exact(recordings, "title") || exact(releases, "title");
}

export async function lookupMediaConcepts(
  title: string,
  fetchFn: typeof fetch = fetch,
): Promise<MediaConcept[]> {
  const term = searchTerm(title);
  // Multi-word or very short captures are usually real to-dos, not track names.
  if (term.length < 3 || term.split(/\s+/).length > 4) return [];
  const base = "https://musicbrainz.org/ws/2";
  const q = encodeURIComponent(term);
  try {
    const [a, r] = await Promise.all([
      fetchFn(`${base}/artist?query=${q}&fmt=json&limit=3`),
      fetchFn(`${base}/recording?query=${q}&fmt=json&limit=3`),
    ]);
    if (!a.ok && !r.ok) return [];
    const artists = a.ok ? ((await a.json()) as { artists?: MbEntity[] }).artists ?? [] : [];
    const recordings = r.ok ? ((await r.json()) as { recordings?: MbEntity[] }).recordings ?? [] : [];
    return isKnownMusic(term, artists, recordings, []) ? ["music"] : [];
  } catch {
    return []; // offline or blocked — the local lexicon remains the authority
  }
}
