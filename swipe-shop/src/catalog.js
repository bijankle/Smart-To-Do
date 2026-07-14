/**
 * Swipe Shop catalog — a curated, offline product feed that stands in for the
 * live inventory of the big shopping platforms (Amazon, Instagram ads, Etsy,
 * eBay, Walmart, ASOS). Products carry the feature tags the taste engine
 * learns from; `productUrl` deep-links each card to a search for it on its
 * home platform, since this app never handles checkout itself.
 *
 * @typedef {"amazon"|"instagram"|"etsy"|"ebay"|"walmart"|"asos"} Platform
 * @typedef {"budget"|"mid"|"premium"|"luxury"} PriceBand
 * @typedef {Object} Product
 * @property {string} id
 * @property {string} title
 * @property {string} brand
 * @property {Platform} platform
 * @property {string} category
 * @property {number} price          USD
 * @property {string[]} tags         style/attribute keywords the model learns
 * @property {string} emoji          card art (no remote images; works offline)
 * @property {number} hue            gradient hue for the card art, 0–360
 * @property {string} blurb          one-line ad-style copy shown on the card
 */

export const PLATFORM_LABELS = {
  amazon: "Amazon",
  instagram: "Instagram Ads",
  etsy: "Etsy",
  ebay: "eBay",
  walmart: "Walmart",
  asos: "ASOS",
};

export const CATEGORY_LABELS = {
  fashion: "Fashion",
  footwear: "Footwear",
  tech: "Tech",
  home: "Home",
  kitchen: "Kitchen",
  fitness: "Fitness",
  beauty: "Beauty",
  outdoors: "Outdoors",
  gaming: "Gaming",
  pets: "Pets",
  stationery: "Stationery",
  travel: "Travel",
};

export const PRICE_BAND_LABELS = {
  budget: "Under $20",
  mid: "$20–75",
  premium: "$75–200",
  luxury: "$200+",
};

/** @param {number} price @returns {PriceBand} */
export function priceBand(price) {
  if (price < 20) return "budget";
  if (price < 75) return "mid";
  if (price < 200) return "premium";
  return "luxury";
}

const SEARCH_URLS = {
  amazon: (q) => `https://www.amazon.com/s?k=${q}`,
  instagram: (q) => `https://www.instagram.com/explore/search/keyword/?q=${q}`,
  etsy: (q) => `https://www.etsy.com/search?q=${q}`,
  ebay: (q) => `https://www.ebay.com/sch/i.html?_nkw=${q}`,
  walmart: (q) => `https://www.walmart.com/search?q=${q}`,
  asos: (q) => `https://www.asos.com/us/search/?q=${q}`,
};

/** Outbound link to the product's home platform — browsing happens there. */
export function productUrl(p) {
  return SEARCH_URLS[p.platform](encodeURIComponent(`${p.brand} ${p.title}`));
}

/**
 * The learnable feature vector of a product. Namespaced so a brand and a tag
 * with the same word never collide.
 * @param {Product} p @returns {string[]}
 */
export function productFeatures(p) {
  return [
    `cat:${p.category}`,
    `brand:${p.brand}`,
    `platform:${p.platform}`,
    `price:${priceBand(p.price)}`,
    ...p.tags.map((t) => `tag:${t}`),
  ];
}

/** Split a namespaced feature back into its kind and value. */
export function featureParts(feature) {
  const i = feature.indexOf(":");
  return { kind: feature.slice(0, i), value: feature.slice(i + 1) };
}

const P = (id, title, brand, platform, category, price, tags, emoji, hue, blurb) =>
  ({ id, title, brand, platform, category, price, tags, emoji, hue, blurb });

/** @type {Product[]} */
export const CATALOG = [
  // ---- fashion ----
  P("fa-01", "Oversized Wool Overcoat", "Norse Atelier", "asos", "fashion", 189, ["minimalist", "cozy", "neutral", "layering"], "🧥", 220, "The one coat that goes with everything you own."),
  P("fa-02", "Vintage Levi's 501 Jeans", "Levi's", "ebay", "fashion", 58, ["vintage", "denim", "casual", "sustainable"], "👖", 215, "Broken-in the honest way — by three decades."),
  P("fa-03", "Silk Slip Midi Dress", "Réalisation Par", "instagram", "fashion", 210, ["statement", "elegant", "night-out", "luxury"], "👗", 330, "The dress your camera roll keeps asking for."),
  P("fa-04", "Heavyweight Boxy Tee 3-Pack", "Uniqlo U", "amazon", "fashion", 39, ["minimalist", "basics", "casual", "neutral"], "👕", 200, "Blank-canvas tees with actual structure."),
  P("fa-05", "Hand-Knit Chunky Cardigan", "LoomWork Studio", "etsy", "fashion", 145, ["handmade", "cozy", "colorful", "one-of-a-kind"], "🧶", 25, "Knit to order by an actual human named Marta."),
  P("fa-06", "Pleated Tennis Skirt", "Golden Hour", "instagram", "fashion", 42, ["sporty", "cute", "trending", "pastel"], "🎾", 140, "Court to coffee without a costume change."),
  P("fa-07", "Corduroy Chore Jacket", "Field Standard", "asos", "fashion", 88, ["retro", "workwear", "casual", "earthy"], "🧑‍🌾", 35, "Pockets for days. Compliments for weeks."),
  P("fa-08", "Cashmere Crewneck Sweater", "Naadam", "amazon", "fashion", 98, ["luxury", "cozy", "minimalist", "neutral"], "🐐", 45, "Cloud-soft cashmere without the eye-watering tag."),

  // ---- footwear ----
  P("fw-01", "Retro Runner Sneakers", "New Balance 990", "amazon", "footwear", 185, ["retro", "sporty", "streetwear", "comfort"], "👟", 240, "Dad shoes fully rehabilitated. Peak comfort."),
  P("fw-02", "Handmade Leather Chelsea Boots", "Thursday Boot Co.", "instagram", "footwear", 199, ["leather", "classic", "workwear", "durable"], "🥾", 30, "Boots that get better every year you own them."),
  P("fw-03", "Platform Canvas Sneakers", "Converse Run Star", "asos", "footwear", 110, ["streetwear", "statement", "trending", "chunky"], "🛹", 300, "Two extra inches of attitude."),
  P("fw-04", "Cloud Slide Sandals", "OOFOS", "walmart", "footwear", 19, ["comfort", "casual", "recovery", "practical"], "🩴", 190, "Like stepping on a marshmallow, medically."),
  P("fw-05", "Trail Running Shoes", "Salomon Speedcross", "amazon", "footwear", 140, ["outdoorsy", "sporty", "technical", "durable"], "⛰️", 105, "Grip that laughs at mud."),
  P("fw-06", "Vintage Cowboy Boots", "Tony Lama", "ebay", "footwear", 95, ["vintage", "statement", "leather", "western"], "🤠", 20, "Someone two-stepped in these before you were born."),

  // ---- tech ----
  P("te-01", "Noise-Cancelling Headphones", "Sony WH-1000XM5", "amazon", "tech", 348, ["techy", "premium", "travel-friendly", "wireless"], "🎧", 250, "The world, on mute. Your playlist, in HD."),
  P("te-02", "Mechanical Keyboard 75%", "Keychron Q1", "amazon", "tech", 169, ["techy", "customizable", "desk-setup", "tactile"], "⌨️", 260, "Thock so good your coworkers will ask about it."),
  P("te-03", "Instant Retro Camera", "Fujifilm Instax Mini", "walmart", "tech", 79, ["retro", "cute", "gift-worthy", "creative"], "📸", 165, "Photos you can hold. Remember those?"),
  P("te-04", "Smart Light Strip Kit", "Govee", "amazon", "tech", 24, ["techy", "smart-home", "colorful", "budget-fun"], "💡", 275, "Your room, but with a sunset setting."),
  P("te-05", "Minimal E-Ink Reader", "Kobo Clara", "walmart", "tech", 139, ["minimalist", "cozy", "reading", "travel-friendly"], "📚", 210, "A thousand books, zero notifications."),
  P("te-06", "Refurbished iPod Classic", "Apple", "ebay", "tech", 120, ["retro", "one-of-a-kind", "music", "collector"], "🎵", 205, "160GB of songs and absolutely no algorithm."),
  P("te-07", "Portable Espresso Maker", "Wacaco Picopresso", "instagram", "tech", 130, ["travel-friendly", "coffee", "technical", "gift-worthy"], "☕", 40, "Barista-grade shots on a mountain, if you insist."),

  // ---- home ----
  P("ho-01", "Linen Duvet Cover Set", "Quince", "instagram", "home", 150, ["minimalist", "cozy", "neutral", "sustainable"], "🛏️", 42, "Stonewashed linen that makes 7am feel optional."),
  P("ho-02", "Ceramic Table Lamp", "West Elm Asymmetry", "amazon", "home", 129, ["sculptural", "statement", "warm-light", "modern"], "🏺", 38, "A lamp that doubles as the room's best sentence."),
  P("ho-03", "Handmade Walnut Cutting Board", "Grain & Forge", "etsy", "home", 85, ["handmade", "earthy", "kitchen-adjacent", "gift-worthy"], "🪵", 28, "End-grain walnut, oiled by hand in Vermont."),
  P("ho-04", "Vintage Persian Runner Rug", "Heritage Weave", "ebay", "home", 240, ["vintage", "colorful", "statement", "one-of-a-kind"], "🧿", 355, "Eighty years old and still the loudest thing in the hall."),
  P("ho-05", "Cloud Bouclé Accent Chair", "Homery", "walmart", "home", 189, ["cozy", "sculptural", "neutral", "trending"], "🛋️", 48, "The chair everyone fights over. Order two."),
  P("ho-06", "Monstera Plant + Ceramic Pot", "The Sill", "instagram", "home", 68, ["plants", "cozy", "earthy", "wellness"], "🪴", 130, "Hard to kill, easy to love."),
  P("ho-07", "Scented Candle Trio", "Brooklyn Candle Studio", "etsy", "home", 48, ["cozy", "gift-worthy", "wellness", "handmade"], "🕯️", 55, "Santal, fig, and 'rainy bookstore.'"),

  // ---- kitchen ----
  P("ki-01", "Dutch Oven 5.5qt", "Le Creuset", "amazon", "kitchen", 380, ["luxury", "classic", "colorful", "heirloom"], "🍲", 15, "The pot your grandkids will argue over."),
  P("ki-02", "Pour-Over Coffee Set", "Hario V60", "amazon", "kitchen", 32, ["coffee", "minimalist", "ritual", "budget-fun"], "🫖", 35, "Slow coffee for fast mornings."),
  P("ki-03", "Carbon Steel Chef's Knife", "Forge & Steel Co.", "etsy", "kitchen", 165, ["handmade", "technical", "heirloom", "kitchen-adjacent"], "🔪", 230, "Hand-forged, scary sharp, weirdly beautiful."),
  P("ki-04", "Smart Air Fryer 6qt", "Ninja", "walmart", "kitchen", 89, ["practical", "techy", "family", "healthy"], "🍟", 25, "Crispy everything, guilt approximately nothing."),
  P("ki-05", "Matcha Ceremony Kit", "Ippodo", "instagram", "kitchen", 56, ["ritual", "wellness", "cozy", "gift-worthy"], "🍵", 120, "Whisk, bowl, and a calmer version of you."),
  P("ki-06", "Retro Stand Mixer", "SMEG 50s Style", "amazon", "kitchen", 450, ["retro", "luxury", "statement", "pastel"], "🎂", 165, "Bakes like a dream, poses like a movie prop."),

  // ---- fitness ----
  P("fi-01", "Walking Pad Treadmill", "UREVO", "amazon", "fitness", 199, ["wellness", "desk-setup", "practical", "trending"], "🚶", 195, "Hit 10k steps without leaving your inbox."),
  P("fi-02", "Cork Yoga Mat", "Yoloha", "instagram", "fitness", 89, ["wellness", "sustainable", "earthy", "ritual"], "🧘", 110, "Grippier when you sweat. Kinder to the planet."),
  P("fi-03", "Adjustable Dumbbell Pair", "Bowflex SelectTech", "walmart", "fitness", 429, ["technical", "practical", "home-gym", "luxury"], "🏋️", 245, "Fifteen dumbbells in the footprint of two."),
  P("fi-04", "Smart Jump Rope", "Crossrope", "instagram", "fitness", 99, ["sporty", "techy", "travel-friendly", "trending"], "⏱️", 150, "Cardio that counts itself."),
  P("fi-05", "Resistance Band Set", "Fit Simplify", "amazon", "fitness", 14, ["budget-fun", "practical", "travel-friendly", "home-gym"], "💪", 175, "A gym that fits in a sock drawer."),

  // ---- beauty ----
  P("be-01", "Vitamin C Glow Serum", "Glow Recipe", "instagram", "beauty", 46, ["wellness", "trending", "self-care", "cute"], "🍉", 340, "Watermelon-bright skin, no filter required."),
  P("be-02", "Handmade Goat Milk Soap Set", "Meadow & Co.", "etsy", "beauty", 22, ["handmade", "earthy", "gift-worthy", "sustainable"], "🧼", 90, "Small-batch soap from actual meadow goats."),
  P("be-03", "Ceramic Hair Styler", "Dyson Airwrap", "amazon", "beauty", 599, ["luxury", "techy", "trending", "premium"], "💇", 315, "The blowout, democratized."),
  P("be-04", "Eau de Parfum Discovery Set", "Maison Margiela REPLICA", "asos", "beauty", 38, ["elegant", "gift-worthy", "ritual", "night-out"], "🌸", 320, "Eight tiny memories in a box."),

  // ---- outdoors ----
  P("ou-01", "Ultralight Camping Hammock", "Kammok Roo", "amazon", "outdoors", 69, ["outdoorsy", "travel-friendly", "cozy", "minimalist"], "🏕️", 115, "Sleep between two trees. Wake up smug."),
  P("ou-02", "Insulated Field Jacket", "Fjällräven", "asos", "outdoors", 225, ["outdoorsy", "workwear", "durable", "classic"], "🦊", 100, "Arctic-grade, sidewalk-approved."),
  P("ou-03", "Cast Iron Campfire Skillet", "Lodge", "walmart", "outdoors", 26, ["outdoorsy", "practical", "heirloom", "kitchen-adjacent"], "🔥", 22, "Pre-seasoned since before it met you."),
  P("ou-04", "Vintage Coleman Lantern", "Coleman", "ebay", "outdoors", 65, ["vintage", "collector", "outdoorsy", "warm-light"], "🏮", 60, "1970s glow, fully restored and hissing happily."),
  P("ou-05", "Packable Sun Shelter", "Shibumi Shade", "instagram", "outdoors", 260, ["beach", "family", "trending", "premium"], "⛱️", 185, "The beach canopy that floats on the wind."),

  // ---- gaming ----
  P("ga-01", "Wireless Pro Controller", "8BitDo Ultimate", "amazon", "gaming", 70, ["techy", "tactile", "desk-setup", "wireless"], "🎮", 265, "Hall-effect sticks. Zero drift. Ever."),
  P("ga-02", "Retro Handheld Console", "Anbernic RG35XX", "amazon", "gaming", 60, ["retro", "collector", "travel-friendly", "budget-fun"], "🕹️", 285, "Your entire childhood, pocket-sized."),
  P("ga-03", "Custom Mechanical Keycap Set", "PixelCaps Studio", "etsy", "gaming", 55, ["customizable", "cute", "desk-setup", "handmade"], "🧩", 305, "Hand-cast keycaps shaped like tiny sushi."),
  P("ga-04", "RGB Gaming Chair", "Secretlab Titan", "amazon", "gaming", 549, ["premium", "techy", "desk-setup", "luxury"], "🪑", 270, "Your spine files a formal thank-you."),

  // ---- pets ----
  P("pe-01", "Orthopedic Dog Bed", "Big Barker", "amazon", "pets", 240, ["pets", "cozy", "premium", "practical"], "🐕", 33, "Ten-year warranty. Infinite naps."),
  P("pe-02", "Custom Pet Portrait", "Whisker & Ink", "etsy", "pets", 45, ["pets", "handmade", "gift-worthy", "one-of-a-kind"], "🖼️", 350, "Your cat, but Renaissance nobility."),
  P("pe-03", "Cat Tunnel Playground", "Mewtopia", "instagram", "pets", 34, ["pets", "cute", "budget-fun", "family"], "🐈", 145, "Zoomies, now with infrastructure."),
  P("pe-04", "GPS Pet Tracker", "Tractive", "walmart", "pets", 50, ["pets", "techy", "practical", "smart-home"], "📍", 155, "Know exactly which neighbor is feeding him."),

  // ---- stationery ----
  P("st-01", "A5 Dot-Grid Journal", "Leuchtturm1917", "amazon", "stationery", 24, ["ritual", "minimalist", "creative", "desk-setup"], "📓", 208, "The notebook that starts habits."),
  P("st-02", "Brass Fountain Pen", "Kaweco Sport", "etsy", "stationery", 89, ["heirloom", "classic", "tactile", "gift-worthy"], "🖋️", 43, "Pocket brass that ages like a good story."),
  P("st-03", "Desk Mat + Organizer Set", "Grovemade", "instagram", "stationery", 120, ["desk-setup", "minimalist", "premium", "earthy"], "🗂️", 95, "Cork and wool. Your desk, but curated."),
  P("st-04", "Vintage Typewriter", "Smith Corona", "ebay", "stationery", 160, ["vintage", "statement", "creative", "collector"], "⌨️", 10, "Serviced, ribboned, and ready for chapter one."),

  // ---- travel ----
  P("tr-01", "Carry-On Roller Suitcase", "Away Bigger Carry-On", "instagram", "travel", 275, ["travel-friendly", "minimalist", "premium", "practical"], "🧳", 235, "The overhead-bin power move."),
  P("tr-02", "Packing Cube System", "Peak Design", "amazon", "travel", 60, ["travel-friendly", "practical", "minimalist", "technical"], "🎒", 225, "Tetris for adults who fly."),
  P("tr-03", "Leather Passport Wallet", "Bexar Goods", "etsy", "travel", 75, ["leather", "handmade", "heirloom", "travel-friendly"], "🛂", 26, "Hand-stitched home for your stamps."),
  P("tr-04", "Instant Language Translator", "Pocketalk", "walmart", "travel", 99, ["techy", "travel-friendly", "practical", "gift-worthy"], "🗣️", 180, "82 languages. Zero awkward pointing."),
  P("tr-05", "Vintage Airline Poster Set", "JetAge Prints", "ebay", "travel", 42, ["vintage", "colorful", "statement", "creative"], "✈️", 200, "Fly TWA to places it no longer flies."),
];
