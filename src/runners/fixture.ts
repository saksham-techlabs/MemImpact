import { RunnerError } from "../core/errors.js";
import type { FixtureCondition, FixtureRunnerConfig, JsonValue, RunInput, Runner, RunnerInfo, RunnerResult } from "../types/index.js";

export function outputToText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function matches(when: FixtureCondition | undefined, input: RunInput): boolean {
  if (!when) return true;
  const ids = new Set(input.memories.map((m) => m.id));
  const context = input.memories.map((m) => m.content).join("\n").toLowerCase();
  const task = input.task.toLowerCase();
  if (when.memoryPresent?.some((id) => !ids.has(id))) return false;
  if (when.memoryAbsent?.some((id) => ids.has(id))) return false;
  if (when.contextIncludes?.some((s) => !context.includes(s.toLowerCase()))) return false;
  if (when.contextExcludes?.some((s) => context.includes(s.toLowerCase()))) return false;
  if (when.taskIncludes?.some((s) => !task.includes(s.toLowerCase()))) return false;
  return true;
}

/**
 * Deterministic rule-based runner for tests, demos and CI. It never calls a
 * model: the first rule whose conditions match the supplied memories wins.
 * `outputs` cycles by repetition number to simulate run-to-run variation.
 */
export class FixtureRunner implements Runner {
  constructor(private readonly config: FixtureRunnerConfig) {}

  info(): RunnerInfo {
    return { type: "fixture", external: false, deterministic: true };
  }

  async run(input: RunInput): Promise<RunnerResult> {
    const index = this.config.rules.findIndex((rule) => matches(rule.when, input));
    const rule = this.config.rules[index];
    if (!rule) throw new RunnerError("No fixture rule matched this input. Add a final rule without `when` as a default.");
    let value: JsonValue;
    if (rule.outputs) {
      value = rule.outputs[(input.repetition - 1) % rule.outputs.length] as JsonValue;
    } else {
      value = rule.output as JsonValue;
    }
    const result: RunnerResult = { output: outputToText(value), metadata: { fixtureRule: index } };
    if (rule.toolCalls) result.toolCalls = rule.toolCalls.map((c) => ({ ...c }));
    return result;
  }
}
