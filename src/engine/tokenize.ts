/**
 * Shared tokenizer for the Naive Bayes classifier.
 * Lowercases, splits on non-alphanumerics, drops single characters,
 * pure numbers, and a small English stopword list.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "at", "be", "by", "for", "from", "get", "go", "in",
  "is", "it", "my", "of", "on", "or", "our", "the", "to", "up", "with",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !STOPWORDS.has(t));
}
