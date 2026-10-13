import type { SectionChange, TextComparison } from "../types/index.js";
import { countOps, diffSequences, sequenceSimilarity, type DiffOp } from "./diff.js";

const WORD_PATTERN = /[\p{L}\p{N}_]+(?:['’.\-+#][\p{L}\p{N}_]+)*(?:\+\+|#)?/gu;

/** NFC, LF line endings, trailing whitespace stripped, whitespace collapsed, case-folded. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .toLowerCase();
}

export function tokenizeWords(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(WORD_PATTERN) ?? [];
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Primary text similarity: word-sequence similarity in [0, 1]. */
export function textSimilarity(a: string, b: string): number {
  if (normalizeText(a) === normalizeText(b)) return 1;
  return sequenceSimilarity(tokenizeWords(a), tokenizeWords(b)).similarity;
}

interface Section {
  title: string;
  key: string;
  body: string;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

export function parseSections(text: string): Section[] | null {
  const lines = splitLines(text);
  if (!lines.some((l) => HEADING.test(l))) return null;
  const sections: Section[] = [];
  let current: Section = { title: "(introduction)", key: "(introduction)", body: "" };
  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      if (current.body.trim() || current.title !== "(introduction)") sections.push(current);
      const title = (match[2] as string).trim();
      current = { title, key: normalizeText(title), body: "" };
    } else {
      current.body += `${line}\n`;
    }
  }
  sections.push(current);
  return sections;
}

export function compareSections(a: string, b: string): SectionChange[] | null {
  const sa = parseSections(a);
  const sb = parseSections(b);
  if (!sa && !sb) return null;
  const left = sa ?? [{ title: "(whole text)", key: "(whole text)", body: a }];
  const right = sb ?? [{ title: "(whole text)", key: "(whole text)", body: b }];
  const rightMap = new Map(right.map((s) => [s.key, s]));
  const changes: SectionChange[] = [];
  const seen = new Set<string>();
  for (const s of left) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    const other = rightMap.get(s.key);
    if (!other) {
      changes.push({ title: s.title, status: "removed" });
      continue;
    }
    const similarity = textSimilarity(s.body, other.body);
    changes.push({ title: s.title, status: similarity === 1 ? "unchanged" : "changed", similarity });
  }
  for (const s of right) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    changes.push({ title: s.title, status: "added" });
  }
  return changes;
}

export function compareText(baseline: string, variant: string): TextComparison {
  const wordsA = tokenizeWords(baseline);
  const wordsB = tokenizeWords(variant);
  const wordDiff = diffSequences(wordsA, wordsB);
  const lineDiff = diffSequences(splitLines(baseline), splitLines(variant));
  const normalizedIdentical = normalizeText(baseline) === normalizeText(variant);
  const total = wordsA.length + wordsB.length;
  const similarity = normalizedIdentical ? 1 : total === 0 ? 1 : (2 * wordDiff.matches) / total;
  const baselineChars = baseline.length;
  const variantChars = variant.length;
  return {
    identical: baseline === variant,
    normalizedIdentical,
    similarity,
    approximate: wordDiff.approximate || lineDiff.approximate,
    lines: countOps(lineDiff),
    words: countOps(wordDiff),
    length: {
      baselineChars,
      variantChars,
      deltaChars: variantChars - baselineChars,
      deltaPercent: baselineChars === 0 ? null : ((variantChars - baselineChars) / baselineChars) * 100,
      baselineWords: wordsA.length,
      variantWords: wordsB.length,
    },
    sections: compareSections(baseline, variant),
  };
}

/** Line diff for verbose display. */
export function lineDiff(baseline: string, variant: string): DiffOp[] {
  return diffSequences(splitLines(baseline), splitLines(variant)).ops;
}
