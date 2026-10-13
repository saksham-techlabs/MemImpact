import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { MemImpactError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { ArtifactOptions, ExperimentResult, RunRecord } from "../types/index.js";

export const RUNS_DIR = "runs";
export const REPORTS_DIR = "reports";
const GITIGNORE_CONTENT = "# MemImpact artifacts can contain memory content and model outputs.\n# They are ignored by default. Remove this file only if you really intend to commit them.\n*\n";

const VALUE_EVIDENCE = /^(Decision field|Field|Tool calls changed)/;
const omitted = (text: string): string => `[omitted sha256:${sha256(text).slice(0, 16)} length:${text.length}]`;

/**
 * Applies the configured privacy options to a copy of the result before it is
 * written to disk. Console/JSON output is not affected.
 */
export function applyArtifactPrivacy(result: ExperimentResult, options: Pick<ArtifactOptions, "storeMemoryContent" | "storeOutputs">): ExperimentResult {
  const copy = structuredClone(result);
  copy.privacy = { memoryContentStored: options.storeMemoryContent, outputsStored: options.storeOutputs };
  if (!options.storeMemoryContent) {
    copy.memories = copy.memories.map((m) => ({ ...m, content: omitted(m.content) }));
    for (const v of copy.variants) {
      const d = v.definition;
      if (d.type === "replace") d.content = omitted(d.content);
      if (d.type === "modify") {
        d.find = omitted(d.find);
        d.replaceWith = omitted(d.replaceWith);
      }
      if (d.type === "add") d.memory = { ...d.memory, content: omitted(d.memory.content) };
      v.description = `${v.type} memory (content omitted)`;
    }
  }
  if (!options.storeOutputs) {
    const scrub = (r: RunRecord): void => {
      if (r.output !== undefined) r.output = omitted(r.output);
      if (r.toolCalls) r.toolCalls = r.toolCalls.map((c) => ({ name: c.name }));
    };
    copy.baseline.runs.forEach(scrub);
    for (const v of copy.variants) {
      v.runs.forEach(scrub);
      if (v.comparison) {
        v.comparison.terms = { baselineOnly: [], variantOnly: [] };
        if (v.comparison.structured) {
          for (const f of v.comparison.structured.fields) {
            f.baseline = f.baseline.map((x) => ({ ...x, value: omitted(x.value) }));
            f.variant = f.variant.map((x) => ({ ...x, value: omitted(x.value) }));
          }
        }
        if (v.comparison.tools) {
          v.comparison.tools.baseline = v.comparison.tools.baseline.map((x) => ({ ...x, value: omitted(x.value) }));
          v.comparison.tools.variant = v.comparison.tools.variant.map((x) => ({ ...x, value: omitted(x.value) }));
        }
      }
      if (v.impact) v.impact.evidence = v.impact.evidence.map((e) => (VALUE_EVIDENCE.test(e) ? e.replace(/(changed|repetitions).*$/s, "$1 (values omitted)") : e));
    }
  }
  return copy;
}

export async function ensureArtifactDir(dir: string): Promise<void> {
  await mkdir(path.join(dir, RUNS_DIR), { recursive: true });
  await mkdir(path.join(dir, REPORTS_DIR), { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!existsSync(gitignore)) await writeFile(gitignore, GITIGNORE_CONTENT, "utf8");
}

export async function saveExperiment(dir: string, result: ExperimentResult, report: string): Promise<{ runFile: string; reportFile: string }> {
  await ensureArtifactDir(dir);
  const runFile = path.join(dir, RUNS_DIR, `${result.experimentId}.json`);
  const reportFile = path.join(dir, REPORTS_DIR, `${result.experimentId}.txt`);
  await writeFile(runFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(reportFile, report.endsWith("\n") ? report : `${report}\n`, "utf8");
  return { runFile, reportFile };
}

export function isExperimentResult(value: unknown): value is ExperimentResult {
  return value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "memimpact.experiment";
}

export async function loadExperiment(dir: string, experimentId: string): Promise<ExperimentResult> {
  if (!/^[A-Za-z0-9-]+$/.test(experimentId)) throw new MemImpactError("usage", `Invalid experiment id "${experimentId}"`);
  const file = path.join(dir, RUNS_DIR, `${experimentId}.json`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new MemImpactError("usage", `Experiment "${experimentId}" not found in ${path.join(dir, RUNS_DIR)}`, ["Use `memimpact list` to see saved experiments."]);
  }
  const data = JSON.parse(text) as unknown;
  if (!isExperimentResult(data)) throw new MemImpactError("runtime", `${file} is not a MemImpact experiment artifact`);
  if (data.schemaVersion !== 1) throw new MemImpactError("runtime", `Unsupported artifact schemaVersion ${String(data.schemaVersion)}`);
  return data;
}

export async function listExperiments(dir: string): Promise<ExperimentResult[]> {
  const runsDir = path.join(dir, RUNS_DIR);
  if (!existsSync(runsDir)) return [];
  const files = (await readdir(runsDir)).filter((f) => f.endsWith(".json")).sort();
  const results: ExperimentResult[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(path.join(runsDir, file), "utf8")) as unknown;
      if (isExperimentResult(data)) results.push(data);
    } catch {
      /* skip unreadable artifacts */
    }
  }
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
