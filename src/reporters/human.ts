import { lineDiff } from "../compare/text.js";
import { attributionLabel } from "../core/impact.js";
import { IMPACT_LEVELS, type CompareResult, type ExperimentResult, type ImpactAssessment, type RunRecord, type VariantComparison, type VariantResult } from "../types/index.js";
import { createStyle, type Style } from "./style.js";

export interface HumanReportOptions {
  color?: boolean;
  verbose?: boolean;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function preview(text: string, maxLines = 8, maxWidth = 110): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth - 1)}…` : l));
  const more = lines.length - maxLines;
  if (more > 0) shown.push(`… (${more} more line${more === 1 ? "" : "s"}; use --verbose)`);
  return shown.length > 0 ? shown : ["(empty output)"];
}

function values(list: { value: string; count: number }[]): string {
  return list.map((v) => (list.length === 1 ? v.value : `${v.value} ×${v.count}`)).join(", ");
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + " ".repeat(width - text.length);
}

function renderRunOutput(lines: string[], title: string, run: RunRecord | undefined, s: Style, verbose: boolean): void {
  if (!run) return;
  lines.push(`  ${s.bold(title)}`);
  if (run.status === "error") {
    lines.push(`    ${s.red(`error: ${run.error ?? "unknown"}`)}`);
    return;
  }
  const body = verbose ? (run.output ?? "").split("\n") : preview(run.output ?? "");
  for (const l of body) lines.push(`    ${s.dim("│")} ${l}`);
}

export function renderComparisonBody(lines: string[], comparison: VariantComparison, impact: ImpactAssessment, s: Style, verbose: boolean): void {
  lines.push(`  Impact:         ${s.level(impact.level)}`);
  lines.push(`  Evidence basis: ${attributionLabel(impact.attribution, comparison.runs)}`);
  lines.push("");
  lines.push(`  ${s.bold("Observed changes")}`);
  for (const e of impact.evidence) lines.push(`    - ${e}`);

  const structured = comparison.structured;
  if (structured) {
    lines.push("");
    lines.push(`  ${s.bold("Structured fields")} ${s.dim(`(JSON parsed in ${structured.parsed.baseline}/${structured.parsed.baselineTotal} baseline, ${structured.parsed.variant}/${structured.parsed.variantTotal} variant runs)`)}`);
    const width = Math.min(40, Math.max(12, ...structured.fields.map((f) => f.path.length + 2)));
    const relevant = verbose ? structured.fields : structured.fields.filter((f) => f.status !== "unchanged" || f.decision);
    const shown = relevant.slice(0, verbose ? relevant.length : 25);
    for (const f of shown) {
      const status = f.status.toUpperCase();
      const colored = f.status === "unchanged" ? s.green(pad(status, 10)) : f.status === "mixed" ? s.yellow(pad(status, 10)) : s.red(pad(status, 10));
      const detail = f.status === "unchanged" ? values(f.baseline) : `${values(f.baseline)} → ${values(f.variant)}`;
      lines.push(`    ${pad(f.path, width)}${colored}${detail}`);
    }
    const hidden = structured.fields.length - shown.length;
    if (hidden > 0) lines.push(s.dim(`    … ${hidden} more unchanged/non-decision fields (use --verbose)`));
    if (structured.ignoredPaths.length > 0) lines.push(s.dim(`    ignored: ${structured.ignoredPaths.join(", ")}`));
  } else if (comparison.structuredNote) {
    lines.push("");
    lines.push(s.dim(`  ${comparison.structuredNote}`));
  }

  const t = comparison.representative;
  const n = comparison.noise;
  lines.push("");
  lines.push(`  ${s.bold("Text")} ${s.dim("(baseline run 1 vs variant run 1)")}`);
  lines.push(`    Similarity      ${pct(t.similarity)}${t.approximate ? " (approximate: very large diff)" : ""}`);
  lines.push(`    Mean similarity ${pct(n.crossSimilarity)} across ${comparison.runs.baseline}×${comparison.runs.variant} baseline/variant pairs`);
  if (n.baselineSelfSimilarity !== null) lines.push(`    Baseline self   ${pct(n.baselineSelfSimilarity)} (agreement between baseline repetitions)`);
  if (n.variantSelfSimilarity !== null) lines.push(`    Variant self    ${pct(n.variantSelfSimilarity)} (agreement between variant repetitions)`);
  lines.push(`    Exact match     ${t.identical ? "yes" : "no"} · normalized match ${t.normalizedIdentical ? "yes" : "no"}`);
  lines.push(`    Lines           +${t.lines.added} −${t.lines.removed} (${t.lines.unchanged} unchanged)`);
  lines.push(`    Words           +${t.words.added} −${t.words.removed} (${t.words.unchanged} unchanged)`);
  const deltaPct = t.length.deltaPercent === null ? "" : ` (${t.length.deltaPercent >= 0 ? "+" : "−"}${Math.abs(t.length.deltaPercent).toFixed(1)}%)`;
  lines.push(`    Length          ${t.length.baselineChars} → ${t.length.variantChars} chars${deltaPct}, ${t.length.baselineWords} → ${t.length.variantWords} words`);
  if (t.sections) {
    const groups = (["changed", "added", "removed", "unchanged"] as const)
      .map((status) => {
        const titles = t.sections?.filter((x) => x.status === status).map((x) => x.title) ?? [];
        return titles.length > 0 ? `${status}: ${titles.join(", ")}` : null;
      })
      .filter((g): g is string => g !== null);
    lines.push(`    Sections        ${groups.join(" · ")}`);
  }
  if (comparison.terms.baselineOnly.length > 0) lines.push(`    Only in baseline: ${comparison.terms.baselineOnly.join(", ")}`);
  if (comparison.terms.variantOnly.length > 0) lines.push(`    Only in variant:  ${comparison.terms.variantOnly.join(", ")}`);

  if (comparison.tools) {
    const tc = comparison.tools;
    lines.push("");
    lines.push(`  ${s.bold("Tool calls")} ${tc.status.toUpperCase()}`);
    lines.push(`    baseline: ${values(tc.baseline)}`);
    lines.push(`    variant:  ${values(tc.variant)}`);
    if (tc.addedTools.length > 0) lines.push(`    tools only in variant:  ${tc.addedTools.join(", ")}`);
    if (tc.removedTools.length > 0) lines.push(`    tools only in baseline: ${tc.removedTools.join(", ")}`);
  }
}

function renderVariant(lines: string[], result: ExperimentResult, v: VariantResult, s: Style, verbose: boolean): void {
  lines.push("");
  lines.push(s.bold(`━━ Variant: ${v.id}${v.auto ? " (auto)" : ""}`));
  lines.push(`  Memory change:  ${v.description}`);
  if (v.error) {
    lines.push(`  ${s.red(`Error: ${v.error}`)}`);
  }
  const failed = v.runs.filter((r) => r.status === "error");
  for (const r of failed) lines.push(`  ${s.red(`Run ${r.id} failed: ${r.error ?? "unknown error"}`)}`);
  if (v.comparison && v.impact) {
    renderComparisonBody(lines, v.comparison, v.impact, s, verbose);
    if (verbose) {
      const a = result.baseline.runs.find((r) => r.status === "ok")?.output;
      const b = v.runs.find((r) => r.status === "ok")?.output;
      if (a !== undefined && b !== undefined) {
        lines.push("");
        lines.push(`  ${s.bold("Line diff")} ${s.dim("(baseline run 1 → variant run 1)")}`);
        for (const op of lineDiff(a, b)) {
          for (const item of op.items) {
            if (op.type === "insert") lines.push(s.green(`    + ${item}`));
            else if (op.type === "delete") lines.push(s.red(`    - ${item}`));
            else lines.push(s.dim(`      ${item}`));
          }
        }
      }
    }
    lines.push("");
    renderRunOutput(lines, "Variant output (run 1)", v.runs.find((r) => r.status === "ok"), s, verbose);
  }
  if (v.expectation) {
    lines.push("");
    lines.push(`  Expectation:    ${v.expectation.passed ? s.green("PASS") : s.red("FAIL")} — ${v.expectation.message}`);
  }
}

export function renderExperiment(result: ExperimentResult, options: HumanReportOptions = {}): string {
  const s = createStyle(options.color ?? false);
  const verbose = options.verbose ?? false;
  const lines: string[] = [];
  lines.push(s.bold(`MemImpact · experiment ${result.experimentId}`));
  if (result.name) lines.push(`Name:         ${result.name}`);
  lines.push(`Task:         ${result.task.replace(/\s+/g, " ").trim()}`);
  const r = result.runner;
  const runnerBits = [r.type, r.model, r.endpoint, r.command].filter(Boolean).join(" · ");
  const settings = [
    r.deterministic ? "deterministic" : null,
    r.temperature !== undefined ? `temperature ${r.temperature}` : null,
    r.seed !== undefined ? `seed ${r.seed}` : null,
    r.external ? "EXTERNAL provider" : "local",
  ].filter(Boolean);
  lines.push(`Runner:       ${runnerBits} (${settings.join(", ")})`);
  lines.push(`Repetitions:  ${result.repetitions} per condition`);
  lines.push(`Memories:     ${result.memories.map((m) => m.id).join(", ") || "(none)"}`);
  lines.push("");
  const baselineFailed = result.baseline.runs.filter((x) => x.status === "error");
  lines.push(s.bold(`━━ Baseline (all ${result.memories.length} memories)`));
  for (const x of baselineFailed) lines.push(`  ${s.red(`Run ${x.id} failed: ${x.error ?? "unknown error"}`)}`);
  renderRunOutput(lines, "Baseline output (run 1)", result.baseline.runs.find((x) => x.status === "ok"), s, verbose);

  for (const v of result.variants) renderVariant(lines, result, v, s, verbose);

  const sum = result.summary;
  lines.push("");
  lines.push(s.bold("━━ Summary"));
  const levels = [...IMPACT_LEVELS].reverse().map((l) => `${s.level(l)} ${sum.byLevel[l]}`).join(" · ");
  lines.push(`  Variants: ${sum.variants} · ${levels}`);
  const ranked = result.variants
    .filter((v) => v.impact)
    .map((v) => `${v.id}=${(v.impact?.level ?? "none").toUpperCase()}`)
    .join(", ");
  if (ranked) lines.push(`  Per variant: ${ranked}`);
  if (sum.failedRuns > 0) lines.push(s.red(`  Failed runs: ${sum.failedRuns}`));
  const withExpectations = result.variants.filter((v) => v.expectation).length;
  if (withExpectations > 0) {
    const failed = sum.expectationsFailed;
    lines.push(`  Expectations: ${withExpectations - failed} passed, ${failed > 0 ? s.red(`${failed} failed`) : "0 failed"}`);
  }
  const tokens = [...result.baseline.runs, ...result.variants.flatMap((v) => v.runs)].reduce((n, x) => n + (x.usage?.totalTokens ?? 0), 0);
  if (tokens > 0) lines.push(`  Tokens reported by provider: ${tokens}`);
  lines.push(`  Duration: ${(result.durationMs / 1000).toFixed(2)}s`);
  lines.push("");
  lines.push(s.dim(`Important: ${result.disclaimer}`));
  return lines.join("\n");
}

export function renderCompare(result: CompareResult, options: HumanReportOptions = {}): string {
  const s = createStyle(options.color ?? false);
  const lines: string[] = [];
  lines.push(s.bold("MemImpact · compare"));
  lines.push(`A (baseline): ${result.a}`);
  lines.push(`B (variant):  ${result.b}`);
  lines.push("");
  renderComparisonBody(lines, result.comparison, result.impact, s, options.verbose ?? false);
  lines.push("");
  lines.push(s.dim(`Important: ${result.disclaimer}`));
  return lines.join("\n");
}

export function renderExperimentList(results: ExperimentResult[]): string {
  if (results.length === 0) return "No saved experiments.";
  const lines = ["ID                       CREATED (UTC)         VARIANTS  HIGHEST  NAME"];
  for (const r of results) {
    lines.push(
      `${pad(r.experimentId, 25)}${pad(r.createdAt.slice(0, 19).replace("T", " "), 22)}${pad(String(r.summary.variants), 10)}${pad((r.summary.highest ?? "-").toUpperCase(), 9)}${r.name ?? ""}`,
    );
  }
  return lines.join("\n");
}