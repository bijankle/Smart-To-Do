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
  "new", "of", "on", "or", "our", "out", "pick", "please", "should", "some",
  "that", "the", "then", "this", "to", "up", "want", "we", "will", "with",
]);

/** Light plural stem: "onions" → "onion"; keeps short words and "-ss" intact. */
export function stem(token: string): string {
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
