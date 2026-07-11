/**
 * Shared tokenizer for the Naive Bayes classifier and the seed lexicon.
 * Lowercases, splits on non-alphanumerics, drops single characters, pure
 * numbers, and stopwords, then applies a light plural stem so "onions"
 * matches "onion".
 *
 * The stopword list includes capture verbs ("buy", "need", "grab") on
 * purpose: they say nothing about WHERE a task belongs, and every generic
 * token dilutes classification confidence.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "at", "be", "buy", "by", "do", "dont", "for", "from",
  "get", "go", "grab", "im", "in", "is", "it", "me", "must", "my", "need",
  "new", "of", "on", "or", "our", "out", "pick", "please", "shop", "should",
  "some", "store", "that", "the", "then", "this", "to", "up", "want", "we",
  "will", "with",
]);

/**
 * Light plural stem: "onions" → "onion", "batteries" → "battery",
 * "brushes" → "brush"; keeps short words and "-ss" intact. ("-ie" words like
 * cookies → "cooky" mis-stem, but the fuzzy layer snaps those back.)
 */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 3 && /(?:ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t))
    .map(stem)
    .filter((t) => !STOPWORDS.has(t));
}

/** Fat-finger/leet digit stand-ins: "tw33zer" → tweezer, "t9ilet" → toilet. */
const DIGIT_SUBS: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "9": "o",
};

/**
 * Bounded Damerau-Levenshtein distance (substitution/insert/delete/adjacent
 * transposition), early-exiting with max+1 once the distance must exceed max.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] | null = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, current[j - 1]! + 1, prev[j - 1]! + cost);
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prevPrev[j - 2]! + 1);
      }
      current.push(d);
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = current;
  }
  return prev[b.length]!;
}

/**
 * Common English words that must never be treated as typos of catalogue
 * words — a frequent word in a sentence is almost never a misspelling
 * ("trailer" is not a typo of "trainer", "cough" is not "couch"). Exact
 * vocabulary matches still apply; only fuzzy correction is blocked.
 */
const NO_FUZZY = new Set([
  "about", "after", "afternoon", "another", "answer", "anyone", "anything",
  "around", "back", "before", "best", "big", "call", "come", "done", "early",
  "episode", "evening", "everything", "finish", "find", "first", "friend",
  "front", "going", "gone", "good", "great", "high", "house", "idea", "issue",
  "kid", "last", "later", "leave", "left", "little", "long", "look", "low",
  "mate", "maybe", "meeting", "month", "morning", "movie", "musing", "near",
  "next", "nice", "night", "nothing", "other", "over", "people", "person",
  "place", "problem", "question", "random", "ready", "really", "right",
  "room", "school", "season", "send", "series", "short", "show", "side",
  "small", "someone", "something", "start", "story", "stuff", "sure", "tell",
  "text", "thing", "thought", "time", "today", "tomorrow", "tonight",
  "trailer", "under", "unrelated", "very", "watch", "week", "weekend",
  "word", "world", "year", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday",
]);

/**
 * Typo failsafe: map an unknown token onto the vocabulary. Tries, in order:
 * exact match, digit substitution, then bounded edit distance — 1 edit for
 * 5+ letter words, 2 edits for 9+. Short words stay exact-only so "ball"
 * can never drift into "balm", and common English words are never treated
 * as typos. Returns null when nothing plausible matches.
 */
export function correctToken(token: string, vocab: Set<string>): string | null {
  if (vocab.has(token)) return token;
  if (NO_FUZZY.has(token)) return null;

  if (/\d/.test(token)) {
    const swapped = stem(token.replace(/[0134579]/g, (d) => DIGIT_SUBS[d]!));
    if (vocab.has(swapped)) return swapped;
  }

  const max = token.length >= 9 ? 2 : token.length >= 5 ? 1 : 0;
  if (max === 0) return null;
  let best: string | null = null;
  let bestDistance = max + 1;
  for (const word of vocab) {
    // Typos rarely break the first letter — and this guard stops real words
    // from drifting into lookalikes ("chopping" → "shopping").
    if (word[0] !== token[0]) continue;
    const distance = editDistance(token, word, max);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = word;
      if (distance === 1) break; // can't beat 1 for a non-exact match
    }
  }
  return best;
}
