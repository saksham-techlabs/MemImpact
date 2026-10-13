export const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: readonly { source: string; flags: string; replacement: string }[] = [
  { source: String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*`, flags: "g", replacement: `Bearer ${REDACTED}` },
  { source: String.raw`\bsk-[A-Za-z0-9_-]{16,}`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bAIza[0-9A-Za-z_-]{30,}`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bAKIA[0-9A-Z]{16}\b`, flags: "g", replacement: REDACTED },
  { source: String.raw`\bhf_[A-Za-z0-9]{30,}`, flags: "g", replacement: REDACTED },
];

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const MIN_SECRET_LENGTH = 8;

/** Header names that must never be configured with literal values. */
export const SECRET_HEADER_NAME = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|x-auth-token)$/i;

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => new RegExp(p.source, p.flags.replace("g", "")).test(text));
}

export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME.test(name);
}

/**
 * Removes secret values from text and data before it is printed or stored.
 * Secrets are: values of explicitly named environment variables, values of any
 * environment variable whose name looks secret, and well-known key formats.
 */
export class Redactor {
  private readonly values: string[];

  constructor(options: { envNames?: string[]; env?: NodeJS.ProcessEnv; extraValues?: string[] } = {}) {
    const env = options.env ?? process.env;
    const collected = new Set<string>();
    for (const value of options.extraValues ?? []) {
      if (value.length >= MIN_SECRET_LENGTH) collected.add(value);
    }
    for (const name of options.envNames ?? []) {
      const value = env[name];
      if (value && value.length >= MIN_SECRET_LENGTH) collected.add(value);
    }
    for (const [name, value] of Object.entries(env)) {
      if (value && value.length >= MIN_SECRET_LENGTH && isSecretEnvName(name)) collected.add(value);
    }
    this.values = [...collected].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let result = text;
    for (const value of this.values) {
      if (result.includes(value)) result = result.split(value).join(REDACTED);
    }
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(new RegExp(pattern.source, pattern.flags), pattern.replacement);
    }
    return result;
  }

  redactDeep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = this.walk(inner);
      return out;
    }
    return value;
  }
}
