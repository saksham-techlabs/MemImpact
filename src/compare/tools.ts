import type { JsonValue, ToolCall, ToolComparison, ValueCount } from "../types/index.js";
import { classifyValueSets } from "./structured.js";

/** JSON with object keys sorted, so argument key order does not create a difference. */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toolSignature(calls: readonly ToolCall[]): string {
  if (calls.length === 0) return "(no tool calls)";
  return calls.map((c) => (c.arguments === undefined ? c.name : `${c.name}(${canonicalJson(c.arguments)})`)).join(" → ");
}

function tally(values: string[]): ValueCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

/**
 * Compares tool-call sequences (names and arguments, in order) with the same
 * rules as structured fields. Returns null when no run on either side
 * reported tool-call data.
 */
export function compareToolCalls(baseline: (ToolCall[] | undefined)[], variant: (ToolCall[] | undefined)[]): ToolComparison | null {
  if ([...baseline, ...variant].every((c) => c === undefined)) return null;
  const sigA = baseline.map((c) => toolSignature(c ?? []));
  const sigB = variant.map((c) => toolSignature(c ?? []));
  const { status, consistent } = classifyValueSets(sigA, sigB);

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
