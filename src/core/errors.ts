export const EXIT_CODES = {
  ok: 0,
  expectationFailed: 1,
  error: 2,
} as const;

export type ErrorKind = "usage" | "config" | "runner" | "runtime";

export class MemImpactError extends Error {
  readonly kind: ErrorKind;
  readonly details: string[];

  constructor(kind: ErrorKind, message: string, details: string[] = []) {
    super(message);
    this.name = "MemImpactError";
    this.kind = kind;
    this.details = details;
  }
}

export class ConfigError extends MemImpactError {
  constructor(message: string, details: string[] = []) {
    super("config", message, details);
    this.name = "ConfigError";
  }
}

export class UsageError extends MemImpactError {
  constructor(message: string, details: string[] = []) {
    super("usage", message, details);
    this.name = "UsageError";
  }
}

export class RunnerError extends MemImpactError {
  constructor(message: string, details: string[] = []) {
    super("runner", message, details);
    this.name = "RunnerError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
