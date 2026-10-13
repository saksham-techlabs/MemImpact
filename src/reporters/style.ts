import type { ImpactLevel } from "../types/index.js";

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  level(level: ImpactLevel): string;
}

const wrap = (enabled: boolean, open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);

export function createStyle(enabled: boolean): Style {
  const style = {
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
  };
  return {
    ...style,
    level(level: ImpactLevel): string {
      const label = level.toUpperCase();
      if (level === "high") return style.bold(style.red(label));
      if (level === "medium") return style.bold(style.yellow(label));
      if (level === "low") return style.bold(style.cyan(label));
      return style.bold(style.green(label));
    },
  };
}

export function shouldUseColor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  return Boolean(stream.isTTY);
}
