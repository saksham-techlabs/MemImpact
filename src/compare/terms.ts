import { tokenizeWords } from "./text.js";

const STOPWORDS = new Set(
  (
    "the and for are but not you your yours with this that these those from have has had was were will would can could should " +
    "into onto over under than then them they their there here what when where which while who whom why how all any each few more " +
    "most other some such only own same too very just also its it's our ours out off about above below again further once both " +
    "use used using may might must shall does did doing done been being because until between through during before after " +
    "his her hers him she he we us me my mine one two get got make makes made like well way ways"
  ).split(/\s+/),
);

function termSet(text: string): Set<string> {
  return new Set(tokenizeWords(text).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)));
}

/**
 * Terms present in EVERY baseline output and in NO variant output (and vice
 * versa). Requiring consistency across repetitions filters out incidental
 * wording changes caused by ordinary run-to-run variation.
 */
export function distinctiveTerms(baseline: string[], variant: string[], limit = 12): { baselineOnly: string[]; variantOnly: string[] } {
  const setsA = baseline.map(termSet);
  const setsB = variant.map(termSet);
  const pick = (own: Set<string>[], other: Set<string>[]): string[] => {
    const first = own[0];
    if (!first) return [];
    const result: string[] = [];
    for (const term of first) {
      if (own.every((s) => s.has(term)) && other.every((s) => !s.has(term))) result.push(term);
    }
    return result.slice(0, limit);
  };
  return { baselineOnly: pick(setsA, setsB), variantOnly: pick(setsB, setsA) };
}
