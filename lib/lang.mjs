/**
 * Lightweight language guesser for the languages these stores sell in.
 *
 * The point is not linguistic precision — it is catching content that was
 * copied from another backend and never translated, above all Slovak source
 * text left sitting on the CZ/RO/PL/HU stores.
 *
 * Scoring combines characteristic letters (strong signal, since the Slavic
 * alphabets differ) with common function words (needed to separate Czech from
 * Slovak, which share most of their alphabet).
 */

const PROFILES = {
  sk: {
    chars: /[ľĺŕôäť]/g,
    words: ['pre', 'aj', 'ktoré', 'ktorý', 'všetky', 'ako', 'sú', 'je', 'na', 'alebo', 'veľmi', 'viac', 'tiež', 'preto', 'môže', 'vôňa', 'vlasy', 'pleť'],
  },
  cs: {
    chars: /[řěů]/g,
    words: ['pro', 'jsou', 'které', 'který', 'všechny', 'jako', 'je', 'na', 'nebo', 'velmi', 'více', 'také', 'proto', 'může', 'vůně', 'vlasy', 'pleť'],
  },
  pl: {
    chars: /[ąćęłńśźż]/g,
    words: ['dla', 'oraz', 'które', 'który', 'wszystkie', 'jak', 'jest', 'są', 'na', 'lub', 'bardzo', 'więcej', 'także', 'może', 'zapach', 'włosy', 'skóra'],
  },
  ro: {
    chars: /[ăâîșțşţ]/g,
    words: ['pentru', 'și', 'care', 'toate', 'este', 'sunt', 'sau', 'foarte', 'mai', 'poate', 'cu', 'din', 'parfum', 'păr', 'piele'],
  },
  hu: {
    chars: /[őű]/g,
    words: ['és', 'hogy', 'nem', 'egy', 'vagy', 'minden', 'nagyon', 'lehet', 'valamint', 'illat', 'haj', 'bőr', 'amely', 'ami'],
  },
  // Decoys. Not languages these stores sell in — they exist so that English or
  // French boilerplate (theme vendor files carry plenty) ranks as itself rather
  // than being misread as Slovak because of a stray accented letter.
  en: {
    chars: /(?!)/g,
    words: ['the', 'and', 'your', 'with', 'for', 'this', 'that', 'from', 'you', 'are', 'will', 'used', 'section', 'settings'],
  },
  fr: {
    chars: /(?!)/g,
    words: ['le', 'la', 'les', 'des', 'une', 'dans', 'pour', 'vous', 'votre', 'sur', 'aux', 'du', 'en', 'style', 'réglages'],
  },
};

/** Languages the stores actually sell in — decoys are excluded. */
export const SELLING_LANGUAGES = ['sk', 'cs', 'pl', 'ro', 'hu'];

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ');

/**
 * Score a text against every profile.
 * Returns { best, scores, confident } — `confident` is false for text too short
 * or too ambiguous to judge, in which case `best` should not be trusted.
 */
export function detect(text) {
  const clean = stripTags(String(text ?? '')).toLowerCase();
  const tokens = clean.match(/[\p{L}]+/gu) ?? [];

  const scores = {};
  for (const [lang, p] of Object.entries(PROFILES)) {
    const charHits = (clean.match(p.chars) ?? []).length;
    const wordHits = tokens.filter((t) => p.words.includes(t)).length;
    // Characteristic letters are far more discriminating than shared function
    // words, so they carry more weight per hit.
    scores[lang] = charHits * 3 + wordHits;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, top] = ranked[0];
  const runnerUp = ranked[1][1];

  return {
    best,
    scores,
    words: tokens.length,
    confident: tokens.length >= 8 && top >= 3 && top > runnerUp,
  };
}

/**
 * Judge one piece of content against the locale it is supposed to be in.
 * Returns null when there is nothing to flag.
 */
export function mismatch(text, expected) {
  const d = detect(text);
  if (!d.confident) return null;
  if (d.best === expected) return null;
  // Text that reads as English or French is theme boilerplate, not a
  // mistranslation of the merchant's own copy.
  if (!SELLING_LANGUAGES.includes(d.best)) return null;
  return { got: d.best, expected, scores: d.scores, words: d.words };
}
