import type { FieldStatus, JsonValue, StructuredFieldChange, ValueCount } from "../types/index.js";

export const MISSING = "(missing)";

const FENCED_JSON = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/;

/**
 * Extracts a JSON object/array from model output: either the whole output, or
 * the first fenced ```json block. Returns undefined when no JSON is present.
 */
export function extractJson(text: string): JsonValue | undefined {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
  const fenced = FENCED_JSON.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as JsonValue;
      if (value !== null && typeof value === "object") return value;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

function childPath(parent: string, key: string): string {
  if (SIMPLE_KEY.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

/** Flattens JSON to leaf paths, e.g. `services[0].name`. Empty objects/arrays are leaves. */
export function flattenJson(value: JsonValue, prefix = "", out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix || "$", "[]");
    value.forEach((item, i) => flattenJson(item, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) out.set(prefix || "$", "{}");
    for (const key of keys) flattenJson(value[key] as JsonValue, childPath(prefix, key), out);
  } else {
    out.set(prefix || "$", JSON.stringify(value));
  }
  return out;
}

/** True when `path` equals `pattern` or is nested beneath it. */
export function pathMatches(path: string, pattern: string): boolean {
  if (path === pattern) return true;
  return path.startsWith(`${pattern}.`) || path.startsWith(`${pattern}[`);
}

function tally(values: string[]): ValueCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

/**
 * Classifies how the values seen across baseline runs relate to those seen
 * across variant runs.
 * - unchanged: both sides produced the same set of values
 * - changed: no value is shared, and the separation is not explainable by
 *   within-condition variation: either each side produced a single value, or
 *   one side reproduced the same value in every one of its (2+) runs
 * - mixed: the sides share some values, or both sides vary internally so a
 *   lack of overlap is what run-to-run variation alone would produce
 */
export function classifyValueSets(valuesA: readonly string[], valuesB: readonly string[]): { status: "unchanged" | "changed" | "mixed"; consistent: boolean } {
  const setA = new Set(valuesA);
  const setB = new Set(valuesB);
  const consistent = setA.size === 1 && setB.size === 1;
  const sameSet = setA.size === setB.size && [...setA].every((v) => setB.has(v));
  if (sameSet) return { status: "unchanged", consistent };
  const overlap = [...setA].some((v) => setB.has(v));
  if (overlap) return { status: "mixed", consistent };
  const stableA = setA.size === 1 && valuesA.length >= 2;
  const stableB = setB.size === 1 && valuesB.length >= 2;
  return { status: consistent || stableA || stableB ? "changed" : "mixed", consistent };
}

export interface StructuredDiffOptions {
  decisionPaths: string[];
  ignorePaths: string[];
}

/**
 * Compares the distribution of each leaf value across baseline runs and
 * variant runs using `classifyValueSets`. `added`/`removed` are `changed`
 * fields that are missing on one side in every run.
 */
export function compareStructured(
  baseline: JsonValue[],
  variant: JsonValue[],
  options: StructuredDiffOptions,
): { fields: StructuredFieldChange[]; ignoredPaths: string[] } {
  const flatA = baseline.map((v) => flattenJson(v));
  const flatB = variant.map((v) => flattenJson(v));
  const paths = new Set<string>();
  for (const map of [...flatA, ...flatB]) for (const key of map.keys()) paths.add(key);

  const fields: StructuredFieldChange[] = [];
  const ignored = new Set<string>();
  for (const path of [...paths].sort()) {
    if (options.ignorePaths.some((p) => pathMatches(path, p))) {
      ignored.add(path);
      continue;
    }
    const valuesA = flatA.map((m) => m.get(path) ?? MISSING);
    const valuesB = flatB.map((m) => m.get(path) ?? MISSING);
    const classified = classifyValueSets(valuesA, valuesB);
    const consistent = classified.consistent;
    let status: FieldStatus = classified.status;
    if (status === "changed" && consistent && valuesA[0] === MISSING) status = "added";
    else if (status === "changed" && consistent && valuesB[0] === MISSING) status = "removed";
    const decision = options.decisionPaths.length === 0 || options.decisionPaths.some((p) => pathMatches(path, p));
    fields.push({ path, status, consistent, decision, baseline: tally(valuesA), variant: tally(valuesB) });
  }
  return { fields, ignoredPaths: [...ignored] };
}
