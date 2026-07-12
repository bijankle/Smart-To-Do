// Lexicon integrity harness: runs a corpus of realistic captures through the
// real engine (fresh store, the owner's eight store buckets) and grades the
// tagging. Run with:  npm run build && node tools/evaluate-lexicon.mjs
import { Repository } from "../dist/src/storage/repo.js";
import { MemoryPersistence } from "../dist/src/storage/persistence.js";

const C = "Coles", B = "Bunnings", CW = "Chemist Warehouse", JB = "JB Hi-Fi",
  OW = "Officeworks", IK = "Ikea", KM = "Kmart", UQ = "Uniqlo";
const STORES = [C, B, CW, JB, OW, IK, KM, UQ];

// [capture text, required stores, optionally-acceptable extra stores]
const CASES = [
  // ---- Coles: fresh, pantry, freezer ----
  ["milk", [C]], ["full cream milk", [C]], ["free range eggs", [C]],
  ["greek yoghurt", [C]], ["tasty cheese", [C]], ["butter", [C]],
  ["chicken breast", [C]], ["beef mince", [C]], ["lamb chops", [C]],
  ["salmon fillet", [C]], ["prawns", [C]], ["bacon", [C]],
  ["cherry tomatoes", [C]], ["baby spinach", [C]], ["iceberg lettuce", [C]],
  ["red onions", [C]], ["sweet potato", [C]], ["pumpkin", [C]],
  ["zucchini", [C]], ["capsicum", [C]], ["mushrooms", [C]],
  ["bananas", [C]], ["granny smith apples", [C]], ["mandarins", [C]],
  ["blueberries", [C]], ["watermelon", [C]], ["avocados", [C]],
  ["sourdough loaf", [C]], ["croissants", [C]], ["bagels", [C]],
  ["weetbix", [C]], ["rolled oats", [C]], ["muesli", [C]],
  ["basmati rice", [C]], ["spaghetti", [C]], ["penne pasta", [C]],
  ["olive oil", [C], [CW]], ["soy sauce", [C]], ["coconut milk", [C]],
  ["stock cubes", [C]], ["plain flour", [C]], ["caster sugar", [C]],
  ["baking powder", [C]], ["choc chips", [C]], ["tim tams", [C]],
  ["hummus", [C]], ["feta", [C]], ["parmesan", [C]], ["mozzarella", [C]],
  ["tortillas", [C]], ["taco shells", [C]], ["frozen peas", [C]],
  ["ice cream", [C]], ["orange juice", [C]], ["sparkling water", [C]],
  ["coffee beans", [C]], ["tea bags", [C]], ["peanut butter", [C]],
  ["maple syrup", [C]], ["tomato sauce", [C]], ["bbq sauce", [C]],
  ["pickles", [C]], ["olives", [C], [CW]], ["vegemite", [C]], ["milo", [C]],
  // ---- Coles: household aisle ----
  ["toilet paper", [C]], ["paper towels", [C], [KM, OW]], ["garbage bags", [C]],
  ["ziplock bags", [C]], ["dishwashing liquid", [C]], ["laundry powder", [C]],
  ["sponges", [C]], ["baking paper", [C]], ["cling wrap", [C]], ["alfoil", [C]],
  // ---- Chemist Warehouse (many shared with Coles) ----
  ["panadol", [C, CW]], ["nurofen", [C, CW]], ["antihistamines", [CW]],
  ["hayfever tablets", [CW]], ["ventolin", [CW]], ["melatonin", [CW]],
  ["magnesium", [CW]], ["fish oil tablets", [CW], [C, JB]], ["probiotics", [CW]],
  ["zinc supplements", [CW]], ["vitamin c", [C, CW]], ["collagen powder", [CW], [C]],
  ["retinol serum", [CW]], ["facial cleanser", [CW], [C]], ["eye drops", [CW]],
  ["contact lens solution", [CW]], ["thermometer", [CW]], ["pregnancy test", [CW]],
  ["throat lozenges", [CW], [C]], ["cough syrup", [CW], [C]], ["band aids", [C, CW]],
  ["sunscreen", [C, CW]], ["moisturiser", [C, CW]], ["tweezers", [C, CW]],
  ["nail clippers", [C, CW]], ["deodorant", [C, CW]], ["toothpaste", [C, CW]],
  ["electric toothbrush", [C, CW], [JB]], ["shampoo and conditioner", [C, CW]],
  ["condoms", [C, CW]], ["lube", [C, CW]], ["tampons", [C, CW]],
  ["nappies", [C, CW]], ["baby formula", [C, CW]],
  // ---- Bunnings ----
  ["hammer", [B]], ["drill bits", [B]], ["impact driver", [B]],
  ["circular saw", [B]], ["sledgehammer", [B]], ["crowbar", [B]],
  ["spanner set", [B]], ["allen keys", [B]], ["spirit level", [B]],
  ["stud finder", [B]], ["silicone sealant", [B]], ["liquid nails", [B], [C, CW]],
  ["turps", [B]], ["methylated spirits", [B]], ["sandpaper", [B]],
  ["masking tape", [B], [OW]], ["paint brushes", [B]], ["drop sheet", [B], [CW]],
  ["white paint", [B]], ["primer", [B]], ["wheelbarrow", [B]],
  ["shovel", [B]], ["rake", [B]], ["secateurs", [B]], ["pruning shears", [B]],
  ["whipper snipper", [B]], ["lawn mower", [B]], ["chainsaw", [B]],
  ["mulch", [B]], ["potting mix", [B]], ["garden hose", [B]],
  ["sprinkler", [B]], ["pavers", [B]], ["decking oil", [B], [C, CW]],
  ["fence palings", [B]], ["gate hinges", [B]], ["padlock", [B]],
  ["extension cord", [B], [JB]], ["light globes", [B], [C]],
  ["screws and wall plugs", [B]], ["work gloves", [B], [UQ, KM]],
  // ---- JB Hi-Fi ----
  ["laptop", [JB]], ["gaming mouse", [JB]], ["mechanical keyboard", [JB]],
  ["webcam", [JB]], ["monitor", [JB]], ["soundbar", [JB]],
  ["bluetooth speaker", [JB]], ["noise cancelling headphones", [JB]],
  ["airpods", [JB]], ["usb c cable", [JB]], ["hdmi cable", [JB]],
  ["phone case", [JB]], ["screen protector", [JB]], ["sd card", [JB], [OW]],
  ["power bank", [JB], [B]], ["turntable", [JB]], ["record player", [JB]],
  ["ps5 controller", [JB]], ["nintendo switch", [JB], [B]], ["gopro", [JB]],
  ["dash cam", [JB]], ["smart watch", [JB]], ["kindle", [JB]], ["ipad", [JB]],
  ["dyson vacuum", [JB], [KM]],
  // ---- Officeworks ----
  ["printer paper", [OW]], ["a4 paper", [OW]], ["ink cartridges", [OW]],
  ["laminating pouches", [OW]], ["manila folders", [OW]],
  ["whiteboard markers", [OW]], ["sticky notes", [OW]], ["envelopes", [OW]],
  ["stamps", [OW]], ["pens and pencils", [OW]], ["highlighters", [OW]],
  ["ring binder", [OW]], ["calculator", [OW]], ["2026 diary", [OW]],
  ["label maker", [OW]], ["desk organiser", [OW], [IK, KM]],
  ["usb stick", [JB], [OW]], ["shredder", [OW]],
  // ---- Ikea ----
  ["bookshelf", [IK]], ["bedside table", [IK]], ["floor lamp", [IK]],
  ["office chair", [IK], [OW]], ["couch", [IK]], ["rug", [IK]], ["curtains", [IK]],
  ["wardrobe", [IK], [UQ]], ["chest of drawers", [IK]], ["mirror", [IK]],
  ["queen mattress", [IK]], ["desk", [IK], [OW]], ["tv unit", [IK], [JB]],
  ["cushions", [IK], [KM]],
  // ---- Kmart ----
  ["storage tubs", [KM]], ["coat hangers", [KM], [UQ]], ["pegs", [KM]],
  ["laundry basket", [KM], [C]], ["mixing bowls", [KM]], ["chopping board", [KM]],
  ["air fryer", [KM], [JB]], ["kettle", [KM]], ["photo frames", [KM]],
  ["candles", [KM]], ["beach towel", [KM]], ["kids toys", [KM]],
  ["board games", [KM]], ["jigsaw puzzle", [KM]], ["drink bottles", [KM]],
  ["kids lunchbox", [KM]], ["pillows", [KM], [IK]], ["quilt cover", [KM], [IK]],
  ["tupperware", [KM]], ["wrapping paper", [KM], [OW, C]],
  // ---- Uniqlo (general apparel also files into Kmart, a department store) ----
  ["plain t shirts", [UQ, KM]], ["jeans", [UQ, KM]], ["socks", [UQ, KM]],
  ["jocks", [UQ, KM]], ["trackies", [UQ, KM]], ["puffer jacket", [UQ, KM]],
  ["linen shirt", [UQ, KM]], ["chinos", [UQ, KM]], ["belt", [UQ, KM]],
  ["thermals", [UQ, KM]], ["hoodie", [UQ, KM]], ["work shirts", [UQ, KM]],
  ["running shoes", [UQ, KM]], ["beanie", [UQ, KM]],
  // ---- typo resilience ----
  ["tomatoe sauce", [C]], ["shampoo and conditionar", [C, CW]],
  ["scr3ws", [B]], ["keybord", [JB]], ["blueberrys", [C]],
  ["toilat paper", [C]], ["sunscren", [C, CW]],
  // ---- expanded coverage: descriptive names & new vocab ----
  ["1000-piece jigsaw puzzle", [KM]], ["waterproof playing cards", [KM], [OW]],
  ["yoga mat (non-slip)", [KM]], ["resistance bands set", [KM]],
  ["dotted bullet journal", [OW]], ["bicycle chain lubricant", [B]],
  ["sofa bed", [IK]], ["tv unit", [IK], [JB]], ["casserole dish", [KM]],
  ["glucosamine tablets", [CW]], ["fish oil capsules", [C, CW]],
  ["compression stockings", [CW], [UQ, KM]], ["subwoofer", [JB]],
  ["mouse pad", [JB]], ["wall clock", [KM]], ["tablecloth", [KM]],
  ["witch hazel toner", [KM, CW]], ["printer toner cartridge", [OW]],
  ["caster sugar", [C]], ["hiking boots", [UQ, KM]], ["balaclava", [UQ, KM]],
  // ---- convenience foods, med abbreviations, brand eponyms ----
  ["ready meals", [C]], ["frozen lasagne", [C]], ["microwave rice", [C]],
  ["chicken nuggets", [C]], ["mg tablets", [CW]], ["vitamin d tablets", [CW]],
  ["piksters", [C, CW]], ["aux cable", [JB]], ["wart treatment", [C, CW]],
];

const repo = await Repository.open(new MemoryPersistence(), {});
for (const store of STORES) repo.createBucket(store);

let pass = 0;
const misses = [];
const wrong = [];
for (const [text, required, extraOk = []] of CASES) {
  const task = repo.addTask(text);
  const actual = new Set(task.buckets);
  const allowed = new Set([...required, ...extraOk]);
  const missing = required.filter((s) => !actual.has(s));
  const unexpected = [...actual].filter((s) => !allowed.has(s));
  if (missing.length === 0 && unexpected.length === 0) {
    pass += 1;
  } else if (missing.length > 0) {
    misses.push(`${text}  → got [${[...actual]}], missing [${missing}]`);
    if (unexpected.length) wrong.push(`${text}  → unexpected [${unexpected}]`);
  } else {
    wrong.push(`${text}  → got [${[...actual]}], unexpected [${unexpected}]`);
  }
  repo.deleteTask(task.id); // keep each case independent
}

console.log(`\n${pass}/${CASES.length} pass (${((pass / CASES.length) * 100).toFixed(1)}%)\n`);
if (misses.length) console.log(`MISSING TAGS (${misses.length}):\n  ` + misses.join("\n  "));
if (wrong.length) console.log(`\nWRONG TAGS (${wrong.length}):\n  ` + wrong.join("\n  "));
