export const INIT_RUNNERS = ["fixture", "openai-compatible", "command"] as const;
export type InitRunner = (typeof INIT_RUNNERS)[number];

const TASK = "Design the database architecture for a new B2B SaaS product. Reply with JSON containing database, hosting and rationale.";

const MEMORIES = [
  { id: "database-preference", content: "User prefers PostgreSQL over MongoDB." },
  { id: "hosting", content: "Project is deployed on Vercel." },
  { id: "timezone", content: "User works in the IST timezone." },
];

const VARIANTS = [
  {
    id: "remove-db-preference",
    type: "remove",
    memoryId: "database-preference",
    expect: { minImpact: "high" },
  },
  {
    id: "swap-db-preference",
    type: "modify",
    memoryId: "database-preference",
    find: "PostgreSQL over MongoDB",
    replaceWith: "MongoDB over PostgreSQL",
  },
  {
    id: "remove-timezone",
    type: "remove",
    memoryId: "timezone",
    expect: { maxImpact: "low" },
  },
];

const RUNNERS: Record<InitRunner, Record<string, unknown>> = {
  fixture: {
    type: "fixture",
    rules: [
      {
        when: { contextIncludes: ["prefers PostgreSQL"] },
        output: {
          database: "PostgreSQL",
          hosting: "Vercel",
          rationale: "Relational schema with strong consistency, matching the stated PostgreSQL preference.",
        },
      },
      {
        when: { contextIncludes: ["prefers MongoDB"] },
        output: {
          database: "MongoDB",
          hosting: "Vercel",
          rationale: "Document model chosen to match the stated MongoDB preference.",
        },
      },
      {
        output: {
          database: "MongoDB",
          hosting: "Vercel",
          rationale: "Flexible document model for fast iteration on an evolving schema.",
        },
      },
    ],
  },
  "openai-compatible": {
    type: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    temperature: 0,
    seed: 42,
    responseFormat: "json",
    timeoutMs: 120000,
  },
  command: {
    type: "command",
    command: "node",
    args: ["memimpact-agent.mjs"],
    protocol: "envelope",
    timeoutMs: 60000,
  },
};

export function configTemplate(runner: InitRunner): string {
  const config = {
    version: 1,
    name: "database-preference-demo",
    description: "Does the stored database preference change the recommended architecture?",
    task: TASK,
    memories: MEMORIES,
    variants: VARIANTS,
    runner: RUNNERS[runner],
    repetitions: 3,
    compare: { decisionPaths: ["database", "hosting"] },
    artifacts: { dir: ".memimpact" },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const AGENT_FILE = "memimpact-agent.mjs";

export const AGENT_TEMPLATE = `// Example MemImpact command-runner agent.
// MemImpact writes one JSON object to stdin:
//   { memimpact, task, system, memories: [{ id, content }], prompt: { system, user }, repetition }
// and reads the agent's answer from stdout. With protocol "envelope" the answer is:
//   { "output": <string or JSON>, "toolCalls"?: [{ "name", "arguments" }], "usage"?: {...} }
// Replace the logic below with a call to your real agent. If your agent needs an
// API key, read it from an environment variable; never hardcode it here.

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

const context = request.memories.map((m) => m.content).join("\\n").toLowerCase();
const database = context.includes("prefers postgresql") ? "PostgreSQL" : "MongoDB";

process.stdout.write(
  JSON.stringify({
    output: { database, hosting: "Vercel", rationale: \`Chose \${database} based on the available context.\` },
    toolCalls: [{ name: "lookup_docs", arguments: { topic: database } }],
  }),
);
`;
