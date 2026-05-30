/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * BM25+ keyword scorer. English-only — no CJK tokenizer WASM dependencies.
 */

const ENGLISH_STOP_WORDS = [
  "a",
  "about",
  "above",
  "across",
  "after",
  "again",
  "against",
  "all",
  "almost",
  "alone",
  "along",
  "already",
  "also",
  "although",
  "always",
  "am",
  "among",
  "an",
  "and",
  "another",
  "any",
  "anybody",
  "anyone",
  "anything",
  "anywhere",
  "are",
  "area",
  "areas",
  "around",
  "as",
  "at",
  "away",
  "back",
  "be",
  "became",
  "because",
  "become",
  "becomes",
  "been",
  "before",
  "behind",
  "being",
  "below",
  "beside",
  "besides",
  "best",
  "better",
  "between",
  "beyond",
  "both",
  "but",
  "by",
  "came",
  "can",
  "cannot",
  "case",
  "could",
  "day",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "down",
  "each",
  "either",
  "else",
  "even",
  "ever",
  "every",
  "everybody",
  "everyone",
  "everything",
  "fact",
  "few",
  "find",
  "first",
  "for",
  "found",
  "from",
  "get",
  "give",
  "go",
  "going",
  "gone",
  "good",
  "got",
  "great",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "herself",
  "high",
  "him",
  "himself",
  "his",
  "how",
  "however",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "keep",
  "kind",
  "knew",
  "know",
  "known",
  "large",
  "last",
  "less",
  "like",
  "little",
  "long",
  "look",
  "low",
  "made",
  "make",
  "many",
  "may",
  "me",
  "might",
  "mine",
  "more",
  "most",
  "much",
  "must",
  "my",
  "myself",
  "never",
  "new",
  "next",
  "no",
  "nobody",
  "not",
  "nothing",
  "now",
  "of",
  "off",
  "often",
  "old",
  "on",
  "once",
  "one",
  "only",
  "onto",
  "or",
  "other",
  "others",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "part",
  "place",
  "point",
  "quite",
  "rather",
  "really",
  "same",
  "saw",
  "say",
  "see",
  "seen",
  "shall",
  "she",
  "should",
  "since",
  "small",
  "so",
  "some",
  "somebody",
  "someone",
  "something",
  "sometimes",
  "still",
  "such",
  "take",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "therefore",
  "these",
  "they",
  "thing",
  "things",
  "think",
  "this",
  "those",
  "though",
  "thought",
  "through",
  "thus",
  "time",
  "to",
  "today",
  "together",
  "too",
  "took",
  "two",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "use",
  "used",
  "very",
  "want",
  "was",
  "way",
  "we",
  "well",
  "went",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "year",
  "yet",
  "you",
  "your",
  "yours",
  "yourself",
];

const STOP_WORDS: Set<string> = new Set(ENGLISH_STOP_WORDS);

const STEMMER_CACHE_MAX = 10000;
const stemmerCache = new Map<string, string>();

/**
 * Porter Stemmer — reduces words to their root form.
 * "running" → "run", "adventurers" → "adventur"
 */
function porterStemmer(word: string): string {
  if (!word || word.length <= 2) return word;
  if (/[一-鿿㐀-䶿豈-﫿]/.test(word)) return word;

  const cached = stemmerCache.get(word);
  if (cached) return cached;

  let stem = word.toLowerCase();
  let preserveE = false;

  // Step 1a
  if (stem.endsWith("sses")) stem = stem.slice(0, -2);
  else if (stem.endsWith("ies")) stem = stem.slice(0, -2);
  else if (!stem.endsWith("ss") && stem.endsWith("s")) stem = stem.slice(0, -1);

  const hasVowel = (s: string) => /[aeiou]/.test(s);

  // Step 1b
  if (stem.endsWith("eed")) {
    const base = stem.slice(0, -3);
    if (base.length > 0) {
      stem = base + "ee";
      preserveE = true;
    }
  } else if (stem.endsWith("ed")) {
    const base = stem.slice(0, -2);
    if (hasVowel(base)) {
      stem = base;
      if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) {
        stem += "e";
        preserveE = true;
      } else if (/([^aeiouslz])\1$/.test(stem)) stem = stem.slice(0, -1);
    }
  } else if (stem.endsWith("ing")) {
    const base = stem.slice(0, -3);
    if (hasVowel(base)) {
      stem = base;
      if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) {
        stem += "e";
        preserveE = true;
      } else if (/([^aeiouslz])\1$/.test(stem)) stem = stem.slice(0, -1);
    }
  }

  // Step 2
  const step2: Array<[string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["abli", "able"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
  ];
  for (const [suffix, repl] of step2) {
    if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
      stem = stem.slice(0, -suffix.length) + repl;
      if (repl.endsWith("e")) preserveE = true;
      break;
    }
  }

  // Step 3
  const step3: Array<[string, string]> = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
  ];
  for (const [suffix, repl] of step3) {
    if (stem.endsWith(suffix) && stem.length > suffix.length + 2) {
      stem = stem.slice(0, -suffix.length) + repl;
      break;
    }
  }

  // Step 4 — remove final 'e'
  if (stem.endsWith("e") && stem.length > 3 && !preserveE) {
    const base = stem.slice(0, -1);
    const vcCount = (base.match(/[aeiou]+[^aeiou]+/g) || []).length;
    const isCVC = /[^aeiou][aeiou][^aeiouxwy]$/.test(base);
    if (vcCount > 1 || (vcCount === 1 && !isCVC)) stem = base;
  }

  if (stemmerCache.size >= STEMMER_CACHE_MAX) {
    stemmerCache.delete(stemmerCache.keys().next().value!);
  }
  stemmerCache.set(word, stem);
  return stem;
}

export interface TokenizeOptions {
  stem?: boolean;
  removeStopWords?: boolean;
  minLength?: number;
  /** Set false to preserve term frequency for sparse-vector encoding. Default true. */
  dedupe?: boolean;
}

/**
 * Tokenize text for BM25 search. Lowercase, strip punctuation, split whitespace,
 * filter stop words, Porter stem, enforce min length.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  if (!text || typeof text !== "string") return [];

  const { stem = true, removeStopWords = true, minLength = 2, dedupe = true } = options;

  let tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= minLength);

  if (removeStopWords) tokens = tokens.filter((t) => !STOP_WORDS.has(t));
  if (stem) tokens = tokens.map((t) => (/^\d+$/.test(t) || t.length <= 3 ? t : porterStemmer(t)));

  return dedupe ? [...new Set(tokens)] : tokens;
}

// ── BM25+ parameters ──

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;
const DEFAULT_DELTA = 0.5;

interface BM25Options {
  k1?: number;
  b?: number;
  delta?: number;
  sublinearTf?: boolean;
  coverageBonus?: boolean;
}

interface IndexedDocument {
  text: string;
}

/**
 * BM25+ scorer. Build once per query from candidate texts, then score all documents.
 */
export class BM25Scorer {
  private k1: number;
  private b: number;
  private delta: number;
  private sublinearTf: boolean;
  private coverageBonus: boolean;

  private documents: IndexedDocument[] = [];
  private docTfs: Array<Map<string, number>> = [];
  private docLengths: number[] = [];
  private avgDocLen = 0;
  private idf = new Map<string, number>();
  private totalDocs = 0;

  constructor(options: BM25Options = {}) {
    this.k1 = options.k1 ?? DEFAULT_K1;
    this.b = options.b ?? DEFAULT_B;
    this.delta = options.delta ?? DEFAULT_DELTA;
    this.sublinearTf = options.sublinearTf ?? true;
    this.coverageBonus = options.coverageBonus ?? true;
  }

  /** Index a set of documents. Call once before scoring. */
  indexDocuments(documents: IndexedDocument[]): void {
    this.documents = documents;
    this.totalDocs = documents.length;
    this.docTfs = [];
    this.docLengths = [];
    let totalLen = 0;

    for (const doc of documents) {
      const tokens = tokenize(doc.text, { dedupe: false });
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      this.docTfs.push(tf);
      this.docLengths.push(tokens.length);
      totalLen += tokens.length;
    }

    this.avgDocLen = this.totalDocs > 0 ? totalLen / this.totalDocs : 0;

    // Build IDF from full corpus (we scan all candidates, so this is corpus-wide)
    const df = new Map<string, number>();
    for (const tf of this.docTfs) {
      for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    for (const [term, docFreq] of df) {
      const raw = Math.log((this.totalDocs - docFreq + 0.5) / (docFreq + 0.5));
      this.idf.set(term, Math.max(0, raw) + this.delta);
    }
  }

  /**
   * Score a document against query tokens.
   * BM25+ with sublinear TF and coverage bonus.
   */
  scoreDocument(queryTokens: string[], docIndex: number): number {
    if (this.avgDocLen === 0) return 0;
    if (!queryTokens || queryTokens.length === 0) return 0;
    if (docIndex < 0 || docIndex >= this.totalDocs) return 0;

    const docTF = this.docTfs[docIndex];
    const docLen = this.docLengths[docIndex];
    if (!docTF || docLen === undefined || docLen === null) return 0;

    let score = 0;
    let matched = 0;

    for (const token of queryTokens) {
      const rawTf = docTF.get(token) || 0;
      if (rawTf === 0) continue;
      matched++;

      const tf = this.sublinearTf ? Math.log(1 + rawTf) : rawTf;
      const idf = this.idf.get(token) || 0;
      const lenNorm = 1 - this.b + this.b * (docLen / this.avgDocLen);
      score += (idf * (tf * (this.k1 + 1))) / (tf + this.k1 * lenNorm);
    }

    if (this.coverageBonus && queryTokens.length > 0) {
      score *= 1 + (matched / queryTokens.length) * 0.1;
    }

    return score;
  }
}
