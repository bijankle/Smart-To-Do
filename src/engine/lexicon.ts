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

import { stem } from "./tokenize.js";

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

const RAW: RawConcept[] = [
  {
    name: "groceries",
    aliases:
      "groceries grocery food supermarket shopping coles woolworths woolies aldi iga costco kroger safeway tesco lidl",
    vocabulary:
      "milk egg bread butter cheese yogurt cream celery onion garlic potato tomato lettuce spinach carrot broccoli cucumber pepper mushroom apple banana orange grape berry strawberry lemon lime avocado rice pasta noodle flour sugar salt spice cereal oat granola coffee tea juice soda beer wine chicken beef pork fish salmon shrimp bacon sausage ham turkey tofu bean lentil nut almond peanut snack chip cracker cookie chocolate candy sauce ketchup mustard mayo oil vinegar honey jam jelly frozen pizza soup produce dairy bakery deli fruit vegetable meat seafood grocery groceries supermarket",
  },
  {
    name: "hardware",
    aliases: "hardware tools tool diy workshop bunnings mitre lowes homedepot screwfix",
    vocabulary:
      "hammer nail screw screwdriver drill bit saw wrench plier bolt washer anchor stud lumber wood plank plywood paint primer brush roller caulk glue tape measure level sander sandpaper ladder toolbox socket blade tile grout cement concrete pipe fitting valve wire cable outlet switch breaker fuse hinge knob lock shelf bracket hook lightbulb bulb battery filter duct insulation drywall stain varnish clamp chisel",
  },
  {
    name: "electronics",
    aliases: "electronics electronic tech gadgets gadget jb jbhifi officeworks bestbuy harvey",
    vocabulary:
      "tv television monitor screen laptop keyboard mouse charger cable cord hdmi usb ethernet adapter dongle headphone earbud speaker soundbar phone tablet camera webcam drone console controller router modem printer ink toner cartridge ssd harddrive drive ram memory gpu cpu processor motherboard case fan projector smartwatch fitbit kindle remote antenna surge protector powerbank sim stylus tripod microphone gopro chromecast roku firestick",
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
      "gym workout exercise run jog yoga pilate stretch cardio weight lift squat deadlift doctor dentist optometrist appointment checkup assessment screening scan referral specialist surgery prescription medicine pill vitamin supplement therapy therapist physio massage diet calorie protein sleep meditation hospital clinic vaccine blood test xray mri allergy flu injury recovery",
  },
  {
    name: "finance",
    aliases: "finance finances money bills banking budget",
    vocabulary:
      "bank deposit withdraw transfer pay bill payment rent mortgage loan credit debit card statement tax taxes refund receipt budget saving invest investment stock fund etf portfolio insurance premium utility electricity gas water internet phone subscription renew renewal fee interest paycheck salary expense reimburse audit accountant",
  },
  {
    name: "home",
    aliases: "home house household chores cleaning ikea kmart",
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
export function matchConcepts(tokens: string[]): Concept[] {
  const unique = new Set(tokens);
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
