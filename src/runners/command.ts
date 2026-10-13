import { spawn } from "node:child_process";
import path from "node:path";
import { RunnerError } from "../core/errors.js";
import type { CommandRunnerConfig, JsonValue, RunInput, Runner, RunnerInfo, RunnerResult, ToolCall, Usage } from "../types/index.js";
import { outputToText } from "./fixture.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
export const COMMAND_PROTOCOL_VERSION = 1;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function parseEnvelope(stdout: string): RunnerResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new RunnerError("Command output is not valid JSON, but runner.protocol is \"envelope\"", [stdout.slice(0, 200)]);
  }
  if (!isObj(data) || data["output"] === undefined) {
    throw new RunnerError('Envelope must be a JSON object with an "output" field');
  }
  const result: RunnerResult = { output: outputToText(data["output"] as JsonValue) };
  if (data["toolCalls"] !== undefined) {
    if (!Array.isArray(data["toolCalls"])) throw new RunnerError('Envelope "toolCalls" must be an array');
    result.toolCalls = data["toolCalls"].map((c, i): ToolCall => {
      if (!isObj(c) || typeof c["name"] !== "string") throw new RunnerError(`Envelope toolCalls[${i}] must have a string "name"`);
      const call: ToolCall = { name: c["name"] };
      if (c["arguments"] !== undefined) call.arguments = c["arguments"] as JsonValue;
      return call;
    });
  }
  if (isObj(data["usage"])) {
    const usage: Usage = {};
    for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
      const v = data["usage"][key];
      if (typeof v === "number") usage[key] = v;
    }
    result.usage = usage;
  }
  if (typeof data["model"] === "string") result.model = data["model"];
  return result;
}

/**
 * Runs a user-supplied executable as the agent. The run input is written to
 * stdin as JSON; the agent's answer is read from stdout. No shell is used, so
 * arguments are passed verbatim and are not subject to shell expansion.
 * The agent is deliberately NOT told whether it is running the baseline or a
 * variant, so it cannot behave differently on that basis.
 */
export class CommandRunner implements Runner {
  constructor(
    private readonly config: CommandRunnerConfig,
    private readonly baseDir: string,
  ) {}

  info(): RunnerInfo {
    return {
      type: "command",
      command: [this.config.command, ...(this.config.args ?? [])].join(" "),
      external: false,
      deterministic: false,
    };
  }

  run(input: RunInput): Promise<RunnerResult> {
    const cfg = this.config;
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const cwd = path.resolve(this.baseDir, cfg.cwd ?? ".");
    const env: NodeJS.ProcessEnv = {
      ...(cfg.inheritEnv === false ? pickSystemEnv(process.env) : process.env),
      ...(cfg.env ?? {}),
      MEMIMPACT: "1",
      MEMIMPACT_PROTOCOL: String(COMMAND_PROTOCOL_VERSION),
    };
    const payload = JSON.stringify({
      memimpact: COMMAND_PROTOCOL_VERSION,
      task: input.task,
      system: input.system ?? null,
      memories: input.memories,
      prompt: input.prompt,
      repetition: input.repetition,
    });

    return new Promise<RunnerResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;

      const child = spawn(cfg.command, cfg.args ?? [], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        child.kill();
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        finish(() => reject(new RunnerError(`Command timed out after ${timeoutMs}ms: ${cfg.command}`)));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill();
          finish(() => reject(new RunnerError(`Command output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`)));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.reduce((n, b) => n + b.length, 0) < 64 * 1024) stderr.push(chunk);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        const hint =
          error.code === "ENOENT"
            ? [`Executable "${cfg.command}" was not found. Use an executable on PATH (e.g. "node") or an absolute path.`]
            : error.code === "EINVAL" && process.platform === "win32"
              ? ['On Windows, .cmd/.bat files cannot be spawned directly. Use command "cmd.exe" with args ["/d", "/s", "/c", "your.cmd"], or call node directly.']
              : [];
        finish(() => reject(new RunnerError(`Failed to start command "${cfg.command}": ${error.message}`, hint)));
      });
      child.on("close", (code, signal) => {
        const errText = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          const reason = code === null ? `was terminated by signal ${signal ?? "unknown"}` : `exited with code ${code}`;
          finish(() => reject(new RunnerError(`Command ${reason}: ${cfg.command}`, errText ? [errText.slice(-1000)] : [])));
          return;
        }
        const out = Buffer.concat(stdout).toString("utf8");
        finish(() => {
          try {
            if (cfg.protocol === "envelope") resolve(parseEnvelope(out));
            else resolve({ output: out.replace(/\r\n/g, "\n").replace(/\n$/, "") });
          } catch (error) {
            reject(error);
          }
        });
      });
      child.stdin.on("error", () => {
        /* the agent may exit without reading stdin; the close handler reports the outcome */
      });
      child.stdin.end(payload);
    });
  }
}

/** Minimal environment needed for executables to start when inheritEnv is false. */
function pickSystemEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (env[key] !== undefined) out[key] = env[key];
  return out;
}
