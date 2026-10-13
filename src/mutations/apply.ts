import { MemImpactError } from "../core/errors.js";
import type { Memory, RemoveVariant, Variant } from "../types/index.js";

function cloneMemory(memory: Memory): Memory {
  const copy: Memory = { id: memory.id, content: memory.content };
  if (memory.tags) copy.tags = [...memory.tags];
  if (memory.source !== undefined) copy.source = memory.source;
  return copy;
}

function requireMemory(memories: readonly Memory[], id: string, variantId: string): Memory {
  const found = memories.find((m) => m.id === id);
  if (!found) throw new MemImpactError("config", `Variant "${variantId}" references unknown memory "${id}"`);
  return found;
}

/**
 * Returns a NEW memory list with exactly one controlled change applied.
 * The input is never mutated; MemImpact only ever works on in-memory copies.
 */
export function applyVariant(memories: readonly Memory[], variant: Variant): Memory[] {
  const copy = memories.map(cloneMemory);
  switch (variant.type) {
    case "remove":
      requireMemory(copy, variant.memoryId, variant.id);
      return copy.filter((m) => m.id !== variant.memoryId);
    case "replace":
      requireMemory(copy, variant.memoryId, variant.id);
      return copy.map((m) => (m.id === variant.memoryId ? { ...m, content: variant.content } : m));
    case "modify": {
      const target = requireMemory(copy, variant.memoryId, variant.id);
      if (!target.content.includes(variant.find)) {
        throw new MemImpactError("config", `Variant "${variant.id}": text "${variant.find}" not found in memory "${variant.memoryId}"`);
      }
      return copy.map((m) => (m.id === variant.memoryId ? { ...m, content: m.content.split(variant.find).join(variant.replaceWith) } : m));
    }
    case "add":
      if (copy.some((m) => m.id === variant.memory.id)) {
        throw new MemImpactError("config", `Variant "${variant.id}": memory "${variant.memory.id}" already exists`);
      }
      return [...copy, cloneMemory(variant.memory)];
  }
}

function quote(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return `"${single.length > max ? `${single.slice(0, max - 1)}…` : single}"`;
}

export function describeVariant(variant: Variant): string {
  switch (variant.type) {
    case "remove":
      return `Removed memory "${variant.memoryId}"`;
    case "replace":
      return `Replaced memory "${variant.memoryId}" with ${quote(variant.content)}`;
    case "modify":
      return `Modified memory "${variant.memoryId}": ${quote(variant.find, 40)} → ${quote(variant.replaceWith, 40)}`;
    case "add":
      return `Added memory "${variant.memory.id}": ${quote(variant.memory.content)}`;
  }
}

export function variantMemoryId(variant: Variant): string {
  return variant.type === "add" ? variant.memory.id : variant.memoryId;
}

export function autoRemoveVariant(memoryId: string, takenIds: ReadonlySet<string>): RemoveVariant {
  let id = `auto-remove-${memoryId}`.slice(0, 64);
  let n = 2;
  while (takenIds.has(id)) id = `auto-remove-${memoryId}`.slice(0, 60) + `-${n++}`;
  return { id, type: "remove", memoryId, description: "Automatic leave-one-out ablation" };
}
