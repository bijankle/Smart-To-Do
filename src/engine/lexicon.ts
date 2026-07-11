/**
 * Seed lexicon — the app's built-in "common sense", entirely local.
 *
 * Each concept is a category people commonly sort tasks into, with the
 * everyday vocabulary that signals it. Two uses:
 *
 *  1. Seeding: a bucket whose name matches a concept (by name or alias) is
 *     pre-trained with the concept's vocabulary, so "celery and onions" files
 *     into a fresh `groceries` bucket with zero training. Seeds are weighted
 *     lightly, so the user's own corrections dominate over time.
 *  2. Auto-creation: a capture that clearly matches a concept (≥2 distinct
 *     vocabulary hits) with no corresponding bucket can create one.
 *
 * All words pass through the shared tokenizer's stem at load time so they
 * always agree with tokenized capture text.
 */

import { correctToken, stem } from "./tokenize.js";

export interface Concept {
  /** Canonical bucket name used when auto-creating. */
  name: string;
  /** Stemmed alias set: bucket names that map to this concept. */
  aliases: Set<string>;
  /** Stemmed seed vocabulary. */
  vocabulary: string[];
}

interface RawConcept {
  name: string;
  aliases: string;
  vocabulary: string;
}

/**
 * Products sold at BOTH supermarkets and chemists. Listed in both concepts'
 * vocabularies, so a capture like "condoms" tags into Coles AND Chemist
 * Warehouse — the engine multi-tags whenever several concepts match.
 */
const PERSONAL_CARE =
  "condom lube lubricant bandaid bandage plaster gauze panadol paracetamol nurofen ibuprofen aspirin antiseptic dettol savlon tampon liner sanitary deodorant antiperspirant shampoo conditioner bodywash soap toothpaste toothbrush floss mouthwash listerine razor shave shaving gillette schick sunscreen aloe moisturiser moisturizer lotion balm vaseline tissue cotton swab wipe nappy nappies huggies babylove formula colgate sensodyne nivea dove rexona lynx berocca oil vitamin tweezer clipper emery loofah pumice qtip earplug nail powder cream gel aid firstaid kit hair comb hairbrush mask patch pimple acne wart blister inhaler electrolyte creatine epipen repellent face spray heat ear bronzer concealer foundation mascara eyeliner lipstick eyeshadow blush brow lash makeup remover polish perfume cologne aftershave fragrance dye";

const RAW: RawConcept[] = [
  {
    name: "groceries",
    aliases:
      "groceries grocery food supermarket shopping coles woolworths woolies aldi iga costco kroger safeway tesco lidl",
    vocabulary:
      `milk egg bread butter cheese yogurt yoghurt cream celery onion garlic potato tomato lettuce spinach carrot artichoke arugula rocket asparagus aubergine basil beet beetroot bokchoy bok choy sprout cabbage cauliflower celeriac chickpea chive cilantro coriander courgette daikon dill endive fennel ginger jalapeno habanero kohlrabi leek marjoram okra oregano paprika parsley parsnip pea radicchio radish rhubarb rosemary rutabaga swede sage scallion shallot squash taro thyme turnip eggplant horseradish chestnut chamomile blackcurrant redcurrant boysenberry huckleberry elderberry feijoa turmeric cumin cinnamon nutmeg clove cardamom wasabi watercress yam broccoli broccolini kale cucumber pepper capsicum zucchini pumpkin mushroom corn cob apple banana orange mandarin grape berry strawberry blueberry raspberry watermelon rockmelon lemon lime avocado sultana raisin kiwi apricot cherry coconut cranberry currant fig grapefruit mango nectarine papaya passionfruit peach pear pineapple plum pomegranate pomelo clementine tangerine satsuma cantaloupe honeydew melon lychee guava persimmon quince mulberry gooseberry blackberry kumquat dragonfruit jackfruit papaw paw rice pasta spaghetti noodle flour sugar salt spice cereal oat rolled muesli granola coffee tea juice soda sparkling beer wine chicken beef mince steak lamb chop pork fish fillet prawn salmon shrimp bacon sausage ham turkey tofu bean lentil nut almond peanut snack chip cracker cookie cookies biscuit chocolate candy muffin donut custard sauce ketchup mustard mayo mayonnaise aioli dressing seasoning chutney relish pesto kimchi sauerkraut sriracha guacamole gochujang sambal chimichurri zaatar dip miso tahini harissa yeast chili chilli vinegar honey jam jelly maple syrup pickle olive stock cube frozen pizza soup taco tortilla burrito shell hummus feta parmesan mozzarella halloumi sourdough loaf croissant bagel ice range sandwich produce dairy bakery deli fruit vegetable meat seafood grocery groceries supermarket ` +
      // Brands and packaged goods people actually write on lists:
      `milo vegemite weetbix nutella tam arnott arnotts cadbury nescafe moccona bega helga tiptop sanitarium kellogg kelloggs masterfoods heinz leggo dolmio praise barilla coke cola pepsi sprite fanta schweppes lipton twinings dilmah doritos smith smiths pringles allens yoplait chobani vaalia ` +
      // Supermarket cleaning/household aisle:
      `omo dynamo fairy finish ajax windex chux glad gladwrap ziplock wrap foil alfoil baking sponge detergent dishwashing laundry bleach napisan garbage toilet paper kleenex sorbent quilton serviette napkin cake salsa popcorn gum lolly matches lighter mop broom duster trash flower straw toothpick ${PERSONAL_CARE}`,
  },
  {
    name: "hardware",
    aliases: "hardware tools tool diy workshop bunnings mitre lowes homedepot screwfix",
    vocabulary:
      "hammer nail screw screwdriver drill bit saw wrench plier bolt washer anchor stud finder lumber wood plank plywood paint primer brush roller caulk glue tape masking measure level sander sandpaper ladder toolbox socket blade tile grout cement concrete brick paver render pipe fitting valve wire cable outlet switch breaker fuse hinge knob lock padlock shelf bracket hook lightbulb bulb globe battery filter duct insulation drywall stain varnish clamp chisel impact driver sledgehammer mallet crowbar spanner allen key silicone sealant turps turpentine methylated metho wheelbarrow shovel spade rake secateurs pruning shears whipper snipper mower lawnmower lawn chainsaw decking paling fencing fence extension plug wallplug glove drop trolley ryobi makita dewalt bosch ozito stanley sikaflex selleys dulux taubmans cabots gorilla wd40 irwin bahco karcher mulch potting fertiliser fertilizer weedkiller roundup sprinkler hose torch flashlight rope handle multitool pocketknife bait trap mosquito citronella velcro filler filla spakfilla epoxy sanding seed seedling weed lavender goggle paintbrush hivis highvis earmuff bucket",
  },
  {
    name: "electronics",
    aliases: "electronics electronic tech gadgets gadget jb jbhifi bestbuy harvey",
    vocabulary:
      "tv television monitor screen laptop keyboard mouse charger cable cord hdmi usb ethernet adapter dongle headphone earbud noise speaker soundbar bluetooth phone tablet android camera webcam lens drone console controller router modem printer ssd harddrive drive ram memory sd microsd gpu cpu processor motherboard case fan projector smartwatch smart fitbit kindle remote antenna surge protector powerbank power sim stylus tripod microphone gopro chromecast roku firestick playstation xbox nintendo turntable vinyl record player stick dash dashcam cd dvd computer ipod radio boombox headset wristwatch fridge freezer microwave dishwasher washer dryer appliance samsung apple sony jbl bose logitech sandisk seagate anker belkin tplink dlink asus acer lenovo dell brother epson canon airpods iphone ipad macbook pixel galaxy chromebook dyson dualsense ps5 ps4",
  },
  {
    name: "stationery",
    aliases: "stationery officeworks office staples",
    vocabulary:
      "pen pencil notebook notepad paper ream a4 a3 stapler staple envelope binder marker highlighter sharpie eraser ruler scissors clipboard diary planner calculator label sticker sticky note card cardstock ink toner cartridge printer copier laminate laminating laminator pouch whiteboard folder manila divider paperclip pin tack stamp shredder organiser organizer bic staedtler artline uhu bostik postit crayola crayon chalk glitter sketch sketchpad rubber texta derwent",
  },
  {
    name: "furniture",
    aliases: "furniture ikea flatpack",
    vocabulary:
      "couch sofa armchair recliner ottoman futon desk table chair stool bench shelf shelving bookcase bookshelf wardrobe dresser drawer cabinet cupboard mattress bed bedframe headboard nightstand bedside lamp floor rug curtain blind cushion mirror hook rail sideboard buffet hutch trundle daybed unit linen",
  },
  {
    name: "homewares",
    aliases: "homewares kmart target bigw",
    vocabulary:
      "storage container basket bin tub hanger organiser organizer kitchenware plate bowl mug cup glass cutlery utensil pan pot tray jug kettle toaster blender bedding pillow blanket duvet quilt doona towel candle decor frame vase pot planter toy game puzzle lego doll craft wrapping ribbon balloon party hamper mat doormat clock peg chopping board airfryer fryer drink bottle lunchbox thermos esky tennis soccer basketball baseball netball cricket racket racquet yarn knitting sewing thread umbrella sleeping picnic helmet incense album christmas ornament tinsel bauble rolling whisk grater peeler tong strainer spatula ladle knife fork spoon dice domino needle thimble button zipper washcloth plush teddy flyswatter swat sistema pyrex corelle tefal raco tupperware tontine rag cloth",
  },
  {
    name: "clothing",
    aliases: "clothing clothes apparel fashion wardrobe uniqlo zara myer cottonon",
    vocabulary:
      "shirt tshirt tee top pants jeans chino shorts trackie trackies tracksuit jacket puffer hoodie sweater jumper coat sock jocks undies underwear boxer brief bra dress skirt suit tie belt shoe sneaker runner running boot sandal thong scarf glove beanie hat cap pyjama legging singlet thermal blazer cardigan trouser polo swimsuit swimmer trunks activewear uniform vest denim flannel linen raincoat slipper heel loafer bikini blouse camisole fleece gown robe lingerie nightie nightwear tights sweatshirt slacks poncho shawl pashmina sarong waistcoat overalls dungaree cufflink knickers trainer stocking swim swimming hoody sunglasses sunnies corset kaftan romper nightgown swimwear underpants undershirt underclothes cargo tankini kilt necktie bonds champion adidas nike puma levis levi asics converse vans crocs ugg uggs",
  },
  {
    name: "computer",
    aliases: "computer computers pc digital online desk",
    vocabulary:
      "email install uninstall download upload update upgrade backup restore sync scan print pdf file folder rename organize password login account website browser bookmark software program app spreadsheet document slide photo video edit export import convert transfer migrate format reset configure troubleshoot virus antivirus malware driver firmware wifi vpn cloud server domain unsubscribe register signup cancel subscription calendar invite zoom code script database render compress unzip archive digitize",
  },
  {
    name: "work",
    aliases: "work job office career business",
    vocabulary:
      "meeting email report presentation deck slide client customer project deadline invoice proposal contract review standup sprint retro ticket budget spreadsheet document memo boss colleague team manager interview hire resume agenda minute conference zoom slack demo launch release roadmap stakeholder quarterly performance timesheet payroll onboarding training workshop",
  },
  {
    name: "health",
    aliases: "health fitness gym medical wellness chemist pharmacy priceline",
    vocabulary:
      `gym workout exercise run jog yoga pilate stretch cardio weight lift squat deadlift doctor dentist optometrist appointment checkup assessment screening scan referral specialist surgery prescription medicine pill supplement therapy therapist physio massage diet calorie protein sleep meditation hospital clinic vaccine blood test xray mri allergy flu injury recovery ` +
      // Chemist-shelf brands and products:
      `codral telfast zyrtec claratyne gaviscon mylanta imodium hydralyte voltaren nicorette strepsils difflam vicks sudafed demazin otrivin canesten betadine elastoplast blackmores swisse ostelin cenovis qv cetaphil sukin neutrogena bepanthen sudocrem straightener curler curling hairdryer blowdryer antihistamine hayfever ventolin melatonin magnesium probiotic collagen retinol serum facial cleanser eye drop lens solution contact thermometer lozenge throat cough tablet capsule ointment ${PERSONAL_CARE}`,
  },
  {
    name: "finance",
    aliases: "finance finances money bills banking budget",
    vocabulary:
      "bank deposit withdraw transfer pay bill payment rent mortgage loan credit debit card statement tax taxes refund receipt budget saving invest investment stock fund etf portfolio insurance premium utility electricity gas water internet phone subscription renew renewal fee interest paycheck salary expense reimburse audit accountant",
  },
  {
    name: "home",
    aliases: "home house household chores cleaning",
    vocabulary:
      "clean cleaning vacuum mop dust laundry dish dishe trash garbage recycle recycling organize declutter tidy bed sheet towel iron fold closet garage attic basement lawn mow rake leaf snow shovel gutter window curtain blind furniture couch sofa repair fix leak faucet toilet shower drain plant water fridge freezer oven stove microwave dishwasher dryer washer smoke detector thermostat",
  },
  {
    name: "travel",
    aliases: "travel trip vacation holiday",
    vocabulary:
      "flight fly plane airport hotel airbnb booking reserve reservation passport visa luggage suitcase pack packing itinerary trip vacation holiday tour ticket train bus ferry rental map beach mountain camp camping tent hike hiking checkin layover boarding customs currency adapter souvenir",
  },
  {
    name: "car",
    aliases: "car auto vehicle garage supercheap autobarn",
    vocabulary:
      "car oil change tire rotate rotation brake engine battery wash gasoline fuel mechanic service registration inspection license plate wiper windshield transmission coolant antifreeze detail alignment muffler exhaust headlight taillight bumper dent scratch tow parking",
  },
  {
    name: "pets",
    aliases: "pets pet dog cat animals petbarn petstock",
    vocabulary:
      "dog cat puppy kitten pet vet veterinarian groom grooming leash collar harness litter kibble treat feed feeding walk crate kennel aquarium hamster rabbit bird cage flea tick heartworm microchip adoption shelter",
  },
  {
    name: "errands",
    aliases: "errands errand town",
    vocabulary:
      "post office mail package parcel return pickup drop dropoff dry cleaning cleaner pharmacy library dmv notary print copy shipping stamp envelope donate donation thrift recycle appointment",
  },
];

function stemWords(words: string): string[] {
  return [...new Set(words.split(/\s+/).filter(Boolean).map(stem))];
}

export const CONCEPTS: Concept[] = RAW.map((raw) => {
  const aliases = stemWords(raw.aliases);
  return {
    name: raw.name,
    aliases: new Set(aliases),
    // Alias words double as vocabulary so "bunnings run" or "medical
    // assessment" hit their concept even without a specific item word.
    vocabulary: [...new Set([...stemWords(raw.vocabulary), ...aliases])],
  };
});

/**
 * Map a bucket name to a concept: any stemmed word of the name that appears
 * in a concept's alias set counts. "Groceries", "food", and "Grocery Run"
 * all resolve to the groceries concept.
 */
export function conceptForBucketName(name: string): Concept | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  for (const concept of CONCEPTS) {
    if (words.some((w) => concept.aliases.has(w))) return concept;
  }
  return null;
}

/**
 * ALL concepts a capture belongs to — a mixed capture ("onions and a hammer")
 * maps to several buckets; the task itself is never split.
 *
 * Rules, tuned to stay conservative:
 *  - Concepts with 2+ distinct vocabulary hits always qualify.
 *  - When NO concept reaches 2 hits, single-hit concepts qualify only if at
 *    least half of the informative words are recognized overall — so a bare
 *    "laptop" files into electronics and "onions and a hammer" files into
 *    both, while "watch the onion movie trailer" (1 recognized word of 4)
 *    stays untagged.
 */
let unionVocab: Set<string> | null = null;
function fullVocabulary(): Set<string> {
  if (!unionVocab) {
    unionVocab = new Set<string>();
    for (const concept of CONCEPTS) for (const word of concept.vocabulary) unionVocab.add(word);
  }
  return unionVocab;
}

export function matchConcepts(tokens: string[]): Concept[] {
  // Typo failsafe: unknown tokens snap to the nearest vocabulary word.
  const vocab = fullVocabulary();
  const unique = new Set(tokens.map((t) => correctToken(t, vocab) ?? t));
  if (unique.size === 0) return [];

  const recognized = new Set<string>();
  const scored: Array<{ concept: Concept; hitWords: string[] }> = [];
  for (const concept of CONCEPTS) {
    const hitWords = concept.vocabulary.filter((word) => unique.has(word));
    if (hitWords.length > 0) {
      scored.push({ concept, hitWords });
      for (const word of hitWords) recognized.add(word);
    }
  }

  const strong = scored.filter((s) => s.hitWords.length >= 2);
  const claimed = new Set(strong.flatMap((s) => s.hitWords));
  // A single-hit concept still counts when the text is mostly recognized
  // words AND its hit word isn't already explained by a strong concept —
  // so "celery and a drill bit" tags groceries alongside hardware, while
  // the lone "email" in a work-heavy sentence doesn't drag in computer.
  const weak =
    recognized.size * 2 >= unique.size
      ? scored.filter((s) => s.hitWords.length === 1 && !claimed.has(s.hitWords[0]!))
      : [];

  return [...strong.sort((a, b) => b.hitWords.length - a.hitWords.length), ...weak].map(
    (s) => s.concept,
  );
}
