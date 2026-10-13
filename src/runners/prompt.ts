import type { Memory, RenderedPrompt } from "../types/index.js";

export const DEFAULT_MEMORY_PREAMBLE = "Stored memory about the user and project (use it when relevant):";

/**
 * Renders the chat prompt used by model runners. Memory IDs are intentionally
 * not shown to the model so they cannot leak into, or bias, the output.
 */
export function renderPrompt(options: {
  task: string;
  system?: string;
  memoryPreamble?: string;
  memories: readonly Memory[];
}): RenderedPrompt {
  const parts: string[] = [];
  if (options.system?.trim()) parts.push(options.system.trim());
  if (options.memories.length > 0) {
    const lines = options.memories.map((m) => `- ${m.content.trim().replace(/\r?\n/g, "\n  ")}`);
    parts.push(`${options.memoryPreamble ?? DEFAULT_MEMORY_PREAMBLE}\n${lines.join("\n")}`);
  }
  return { system: parts.join("\n\n"), user: options.task };
}
