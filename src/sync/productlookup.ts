/**
 * Online product-lookup fallback for items the offline lexicon can't place.
 *
 * When a capture stays untagged, we ask the open, keyless, CORS-friendly
 * Open Food Facts (food/grocery) and Open Beauty Facts (cosmetics/toiletries)
 * databases what the product is, and map their category tags to the owner's
 * stores. Everything fails soft: offline, rate-limited, or unknown → no tags,
 * exactly as before. This closes grocery/health/beauty gaps; hardware and
 * electronics still rely on the local lexicon.
 *
 * Concept names returned here match the seed-lexicon concepts, so the caller
 * maps them to live buckets with repo.bucketsForConceptName().
 */

const OFF = "https://world.openfoodfacts.org";
const OBF = "https://world.openbeautyfacts.org";

interface OffProduct {
  product_name?: string;
  categories_tags?: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when the found product's name shares a meaningful word with the query. */
function nameMatches(productName: string | undefined, query: string): boolean {
  if (!productName) return false;
  const q = new Set(normalize(query).split(" ").filter((w) => w.length > 2));
  if (q.size === 0) return false;
  return normalize(productName)
    .split(" ")
    .some((w) => w.length > 2 && q.has(w));
}

/** Category tags that mean "personal care / beauty", not food. */
function isBeautyCategory(tags: string[]): boolean {
  const joined = tags.join(" ");
  return /cosmet|beaut|hygien|skin|hair-care|haircare|shampoo|deodor|oral|toothpaste|dental|makeup|make-up|personal-care|soap|lotion|sunscreen|fragrance|perfume|shaving/i.test(
    joined,
  );
}

async function search(base: string, query: string, fetchFn: typeof fetch): Promise<OffProduct | null> {
  const url =
    `${base}/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=3&fields=product_name,categories_tags`;
  const response = await fetchFn(url);
  if (!response.ok) return null;
  const products = ((await response.json()) as { products?: OffProduct[] }).products ?? [];
  return products.find((p) => nameMatches(p.product_name, query)) ?? null;
}

/**
 * Resolve an unknown item to seed-lexicon concept names via the open product
 * databases. Returns [] when nothing confident is found (caller leaves it
 * untagged). Food → ["groceries"]; toiletries/beauty → ["chemist","groceries"]
 * (sold at both a chemist and a supermarket, matching the app's model).
 */
export async function lookupProductConcepts(
  name: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const query = name.trim();
  if (query.length < 3) return [];
  try {
    const food = await search(OFF, query, fetchFn);
    if (food) {
      return isBeautyCategory(food.categories_tags ?? []) ? ["chemist", "groceries"] : ["groceries"];
    }
    const beauty = await search(OBF, query, fetchFn);
    if (beauty) return ["chemist", "groceries"];
    return [];
  } catch {
    return []; // offline, blocked, or rate-limited — stay untagged
  }
}
