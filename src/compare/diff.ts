export type DiffOpType = "equal" | "insert" | "delete";

export interface DiffOp {
  type: DiffOpType;
  items: string[];
}

export interface DiffResult {
  ops: DiffOp[];
  /** Number of items matched by the longest common subsequence. */
  matches: number;
  /** True when the edit distance exceeded the budget and a bag-of-items approximation was used. */
  approximate: boolean;
}

export const DEFAULT_MAX_EDIT_DISTANCE = 4000;

function push(ops: DiffOp[], type: DiffOpType, item: string): void {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.items.push(item);
  else ops.push({ type, items: [item] });
}

/**
 * Myers O(ND) shortest-edit-script diff over two token sequences.
 * Only the band of the V array that each round can touch is snapshotted, so
 * memory is O(D^2). If D exceeds `maxEditDistance`, returns null.
 */
function myers(a: readonly string[], b: readonly string[], maxEditDistance: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: { lo: number; data: Int32Array }[] = [];
  const limit = Math.min(max, maxEditDistance);

  for (let d = 0; d <= limit; d++) {
    const lo = Math.max(0, offset - d - 1);
    const hi = Math.min(v.length, offset + d + 2);
    trace.push({ lo, data: v.slice(lo, hi) });
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, offset);
    }
  }
  return null;
}

function backtrack(a: readonly string[], b: readonly string[], trace: { lo: number; data: Int32Array }[], offset: number): DiffOp[] {
  const reversed: { type: DiffOpType; item: string }[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d] as { lo: number; data: Int32Array };
    const get = (k: number): number => snap.data[offset + k - snap.lo] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : get(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: "equal", item: a[x - 1] as string });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) reversed.push({ type: "insert", item: b[y - 1] as string });
      else reversed.push({ type: "delete", item: a[x - 1] as string });
    }
    x = prevX;
    y = prevY;
  }
  const ops: DiffOp[] = [];
  for (let i = reversed.length - 1; i >= 0; i--) {
    const step = reversed[i] as { type: DiffOpType; item: string };
    push(ops, step.type, step.item);
  }
  return ops;
}

function bagMatches(a: readonly string[], b: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let matches = 0;
  for (const item of b) {
    const c = counts.get(item) ?? 0;
    if (c > 0) {
      matches++;
      counts.set(item, c - 1);
    }
  }
  return matches;
}

export function diffSequences(a: readonly string[], b: readonly string[], maxEditDistance = DEFAULT_MAX_EDIT_DISTANCE): DiffResult {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix = a.slice(0, start);
  const suffix = a.slice(endA);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const ops: DiffOp[] = [];
  for (const item of prefix) push(ops, "equal", item);
  const middle = myers(midA, midB, maxEditDistance);
  let approximate = false;
  let midMatches: number;
  if (middle) {
    for (const op of middle) for (const item of op.items) push(ops, op.type, item);
    midMatches = middle.filter((op) => op.type === "equal").reduce((n, op) => n + op.items.length, 0);
  } else {
    approximate = true;
    midMatches = bagMatches(midA, midB);
    for (const item of midA) push(ops, "delete", item);
    for (const item of midB) push(ops, "insert", item);
  }
  for (const item of suffix) push(ops, "equal", item);
  return { ops, matches: prefix.length + suffix.length + midMatches, approximate };
}

export function countOps(result: DiffResult): { added: number; removed: number; unchanged: number } {
  let added = 0;
  let removed = 0;
  for (const op of result.ops) {
    if (op.type === "insert") added += op.items.length;
    else if (op.type === "delete") removed += op.items.length;
  }
  return { added, removed, unchanged: result.matches };
}

/** Dice-style sequence similarity: 2 * matches / (|a| + |b|). Two empty inputs are identical. */
export function sequenceSimilarity(a: readonly string[], b: readonly string[]): { similarity: number; approximate: boolean } {
  if (a.length === 0 && b.length === 0) return { similarity: 1, approximate: false };
  const result = diffSequences(a, b);
  return { similarity: (2 * result.matches) / (a.length + b.length), approximate: result.approximate };
}
