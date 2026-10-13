import type { ToolCall, ToolComparison, ValueCount } from "../types/index.js";

export function toolSignature(calls: readonly ToolCall[]): string {
  if (calls.length === 0) return "(no tool calls)";
  return calls.map((c) => (c.arguments === undefined ? c.name : `${c.name}(${JSON.stringify(c.arguments)})`)).join(" → ");
}

function tally(values: string[]): ValueCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

/**
 * Compares tool-call sequences (names and arguments, in order). Returns null
 * when no run on either side reported tool-call data.
 */
export function compareToolCalls(baseline: (ToolCall[] | undefined)[], variant: (ToolCall[] | undefined)[]): ToolComparison | null {
  if ([...baseline, ...variant].every((c) => c === undefined)) return null;
  const sigA = baseline.map((c) => toolSignature(c ?? []));
  const sigB = variant.map((c) => toolSignature(c ?? []));
  const setA = new Set(sigA);
  const setB = new Set(sigB);
  const overlap = [...setA].some((s) => setB.has(s));
  const sameSet = setA.size === setB.size && [...setA].every((s) => setB.has(s));
  const consistent = setA.size === 1 && setB.size === 1;
  const status = sameSet ? "unchanged" : !overlap ? "changed" : "mixed";

  const namesA = new Set(baseline.flatMap((c) => (c ?? []).map((t) => t.name)));
  const namesB = new Set(variant.flatMap((c) => (c ?? []).map((t) => t.name)));
  return {
    status,
    consistent,
    baseline: tally(sigA),
    variant: tally(sigB),
    addedTools: [...namesB].filter((n) => !namesA.has(n)).sort(),
    removedTools: [...namesA].filter((n) => !namesB.has(n)).sort(),
  };
}
