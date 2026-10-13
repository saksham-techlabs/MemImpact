import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { RunnerError } from "../src/core/errors.js";
import { CommandRunner } from "../src/runners/command.js";
import { FixtureRunner } from "../src/runners/fixture.js";
import { isLocalEndpoint, OpenAICompatibleRunner, safeEndpoint } from "../src/runners/openai.js";
import { renderPrompt } from "../src/runners/prompt.js";
import type { Memory, RunInput } from "../src/types/index.js";
import { tempDir } from "./helpers.js";

function input(memories: Memory[], repetition = 1, task = "Explain Docker."): RunInput {
  return { task, memories, prompt: renderPrompt({ task, memories }), repetition };
}

const concise: Memory = { id: "style", content: "User prefers concise answers." };

describe("fixture runner", () => {
  const runner = new FixtureRunner({
    type: "fixture",
    rules: [
      { when: { memoryPresent: ["style"], contextIncludes: ["CONCISE"] }, output: "short" },
      { when: { memoryAbsent: ["style"], taskIncludes: ["kubernetes"] }, output: { tool: "k8s" }, toolCalls: [{ name: "search" }] },
      { outputs: ["long one", "long two"] },
    ],
  });

  it("matches rules by memory presence and case-insensitive context", async () => {
    assert.equal((await runner.run(input([concise]))).output, "short");
  });

  it("serializes JSON outputs and returns tool calls", async () => {
    const result = await runner.run(input([], 1, "Explain Kubernetes"));
    assert.equal(result.output, JSON.stringify({ tool: "k8s" }, null, 2));
    assert.deepEqual(result.toolCalls, [{ name: "search" }]);
  });

  it("cycles outputs by repetition deterministically", async () => {
    assert.equal((await runner.run(input([], 1))).output, "long one");
    assert.equal((await runner.run(input([], 2))).output, "long two");
    assert.equal((await runner.run(input([], 3))).output, "long one");
  });

  it("fails when no rule matches", async () => {
    const strict = new FixtureRunner({ type: "fixture", rules: [{ when: { memoryPresent: ["x"] }, output: "x" }] });
    await assert.rejects(strict.run(input([])), RunnerError);
  });

  it("reports itself as deterministic and local", () => {
    assert.deepEqual(runner.info(), { type: "fixture", external: false, deterministic: true });
  });
});

describe("command runner", () => {
  const dir = tempDir();
  const script = (name: string, body: string): string => {
    writeFileSync(path.join(dir, name), body, "utf8");
    return name;
  };
  const echo = script(
    "echo agent.mjs",
    `let s = ""; for await (const c of process.stdin) s += c; const req = JSON.parse(s);
     process.stdout.write("memories=" + req.memories.map(m => m.id).join(",") + " rep=" + req.repetition + " env=" + process.env.MEMIMPACT + " custom=" + process.env.CUSTOM_FLAG + "\\n");`,
  );
  const envelope = script(
    "envelope.mjs",
    `let s = ""; for await (const c of process.stdin) s += c;
     process.stdout.write(JSON.stringify({ output: { answer: 42 }, toolCalls: [{ name: "calc", arguments: { x: 1 } }], usage: { totalTokens: 7 }, model: "custom" }));`,
  );
  const fail = script("fail.mjs", `process.stderr.write("something broke"); process.exit(3);`);
  const slow = script("slow.mjs", `setTimeout(() => {}, 30000);`);
  const badEnvelope = script("bad.mjs", `process.stdout.write("not json");`);
  const noStdin = script("nostdin.mjs", `process.stdout.write("ok");`);

  it("passes the run input on stdin and returns stdout (paths with spaces)", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [echo], env: { CUSTOM_FLAG: "yes" } }, dir);
    const result = await runner.run(input([concise], 2));
    assert.equal(result.output, "memories=style rep=2 env=1 custom=yes");
  });

  it("parses the envelope protocol", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [envelope], protocol: "envelope" }, dir);
    const result = await runner.run(input([]));
    assert.equal(result.output, JSON.stringify({ answer: 42 }, null, 2));
    assert.deepEqual(result.toolCalls, [{ name: "calc", arguments: { x: 1 } }]);
    assert.deepEqual(result.usage, { totalTokens: 7 });
    assert.equal(result.model, "custom");
  });

  it("rejects invalid envelopes", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [badEnvelope], protocol: "envelope" }, dir);
    await assert.rejects(runner.run(input([])), /not valid JSON/);
  });

  it("reports non-zero exit codes with stderr", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [fail] }, dir);
    await assert.rejects(runner.run(input([])), (e: unknown) => e instanceof RunnerError && /exited with code 3/.test(e.message) && e.details.join().includes("something broke"));
  });

  it("times out and kills slow commands", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [slow], timeoutMs: 300 }, dir);
    const started = Date.now();
    await assert.rejects(runner.run(input([])), /timed out after 300ms/);
    assert.ok(Date.now() - started < 10_000);
  });

  it("reports missing executables", async () => {
    const runner = new CommandRunner({ type: "command", command: "memimpact-definitely-missing-binary" }, dir);
    await assert.rejects(runner.run(input([])), /Failed to start command/);
  });

  it("tolerates agents that never read stdin", async () => {
    const runner = new CommandRunner({ type: "command", command: process.execPath, args: [noStdin] }, dir);
    assert.equal((await runner.run(input([]))).output, "ok");
  });

  it("can run without inheriting the parent environment", async () => {
    process.env["MEMIMPACT_TEST_INHERITED"] = "visible";
    const probe = script("probe.mjs", `process.stdout.write(String(process.env.MEMIMPACT_TEST_INHERITED));`);
    const isolated = new CommandRunner({ type: "command", command: process.execPath, args: [probe], inheritEnv: false }, dir);
    const inherited = new CommandRunner({ type: "command", command: process.execPath, args: [probe] }, dir);
    assert.equal((await isolated.run(input([]))).output, "undefined");
    assert.equal((await inherited.run(input([]))).output, "visible");
    delete process.env["MEMIMPACT_TEST_INHERITED"];
  });
});

async function withServer(
  handler: (req: IncomingMessage, body: string) => { status: number; body: unknown },
  fn: (baseUrl: string, requests: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[]) => Promise<void>,
): Promise<void> {
  const requests: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
      const reply = handler(req, body);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/v1`, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const okReply = {
  model: "test-model-2026",
  system_fingerprint: "fp_123",
  choices: [
    {
      finish_reason: "stop",
      message: { content: "Use PostgreSQL.", tool_calls: [{ type: "function", function: { name: "lookup", arguments: '{"q":"pg"}' } }] },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("openai-compatible runner", () => {
  it("sends a chat completion request with deterministic defaults and parses the reply", async () => {
    await withServer(
      () => ({ status: 200, body: okReply }),
      async (baseUrl, requests) => {
        const env = { TEST_PROVIDER_KEY: "test-key-value-123456" };
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m", apiKeyEnv: "TEST_PROVIDER_KEY", seed: 7, responseFormat: "json", maxTokens: 50 }, env);
        const result = await runner.run(input([concise]));
        assert.equal(result.output, "Use PostgreSQL.");
        assert.deepEqual(result.toolCalls, [{ name: "lookup", arguments: { q: "pg" } }]);
        assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        assert.equal(result.model, "test-model-2026");
        assert.equal(result.finishReason, "stop");
        const req = requests[0];
        assert.ok(req);
        assert.equal(req.headers["authorization"], "Bearer test-key-value-123456");
        assert.equal(req.body["temperature"], 0);
        assert.equal(req.body["seed"], 7);
        assert.equal(req.body["max_tokens"], 50);
        assert.deepEqual(req.body["response_format"], { type: "json_object" });
        const messages = req.body["messages"] as { role: string; content: string }[];
        assert.equal(messages[0]?.role, "system");
        assert.match(messages[0]?.content ?? "", /concise answers/);
        assert.deepEqual(messages[1], { role: "user", content: "Explain Docker." });
      },
    );
  });

  it("sends no Authorization header for keyless local servers", async () => {
    await withServer(
      () => ({ status: 200, body: okReply }),
      async (baseUrl, requests) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        await runner.run(input([]));
        assert.equal(requests[0]?.headers["authorization"], undefined);
        const messages = requests[0]?.body["messages"] as unknown[];
        assert.equal(messages.length, 1, "no system message when there is no system prompt or memory");
      },
    );
  });

  it("fails clearly when the configured key variable is missing", () => {
    assert.throws(
      () => new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl: "https://x.test/v1", model: "m", apiKeyEnv: "MISSING_KEY_VAR" }, {}),
      /MISSING_KEY_VAR is not set/,
    );
  });

  it("surfaces HTTP errors and malformed responses", async () => {
    await withServer(
      () => ({ status: 401, body: { error: "bad key" } }),
      async (baseUrl) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        await assert.rejects(runner.run(input([])), /HTTP 401/);
      },
    );
    await withServer(
      () => ({ status: 200, body: { nothing: true } }),
      async (baseUrl) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        await assert.rejects(runner.run(input([])), /no choices/);
      },
    );
  });

  it("joins array-form message content and rejects replies with no content", async () => {
    await withServer(
      () => ({ status: 200, body: { choices: [{ message: { content: [{ type: "text", text: "Use " }, { type: "text", text: "PostgreSQL." }] } }] } }),
      async (baseUrl) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        assert.equal((await runner.run(input([]))).output, "Use PostgreSQL.");
      },
    );
    await withServer(
      () => ({ status: 200, body: { choices: [{ message: { content: null }, finish_reason: "length" }] } }),
      async (baseUrl) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        await assert.rejects(runner.run(input([])), /no message content or tool calls \(finish_reason: length\)/);
      },
    );
  });

  it("reports provider error messages returned with HTTP 200", async () => {
    await withServer(
      () => ({ status: 200, body: { error: { message: "model not loaded" } } }),
      async (baseUrl) => {
        const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl, model: "m" }, {});
        await assert.rejects(runner.run(input([])), (error: unknown) => {
          assert.match(String((error as Error).message), /no choices/);
          assert.deepEqual((error as { details: string[] }).details, ["model not loaded"]);
          return true;
        });
      },
    );
  });

  it("times out while the response body is still streaming", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", timeoutMs: 200 }, {});
      await assert.rejects(runner.run(input([])), /timed out after 200ms/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out", async () => {
    const server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", timeoutMs: 200 }, {});
      await assert.rejects(runner.run(input([])), /timed out after 200ms/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("classifies endpoints as local or external without exposing credentials", () => {
    assert.equal(isLocalEndpoint("http://localhost:11434/v1"), true);
    assert.equal(isLocalEndpoint("http://127.0.0.1:8080/v1"), true);
    assert.equal(isLocalEndpoint("https://api.openai.com/v1"), false);
    assert.equal(safeEndpoint("https://api.example.com/v1/"), "https://api.example.com/v1");
    const runner = new OpenAICompatibleRunner({ type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m", temperature: 0.2, seed: 1 }, {});
    assert.deepEqual(runner.info(), {
      type: "openai-compatible",
      model: "m",
      endpoint: "https://api.example.com/v1",
      external: true,
      deterministic: false,
      temperature: 0.2,
      seed: 1,
    });
  });
});
