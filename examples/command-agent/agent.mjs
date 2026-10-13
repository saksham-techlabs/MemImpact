// A tiny deterministic "agent" used to demonstrate the command runner.
// It reads the MemImpact run input from stdin and writes an envelope to stdout:
//   { "output": <string or JSON>, "toolCalls": [{ "name", "arguments" }] }
// A real integration would forward `request.prompt` (or `request.memories`)
// to your own agent here. Read any API key from the environment; never hardcode it.

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);

const memory = request.memories.map((m) => m.content.toLowerCase()).join("\n");
const readOnly = memory.includes("read-only");
const prefersTickets = memory.includes("open a ticket");

const toolCalls = [{ name: "read_logs", arguments: { service: "billing-api", lines: 200 } }];
let plan;
if (readOnly) {
  toolCalls.push({ name: prefersTickets ? "open_ticket" : "notify_oncall", arguments: { severity: "high", summary: "Missing column invoices.tax_rate" } });
  plan = "The deploy failed because migration 042 was not applied. Production is read-only for agents, so I escalated instead of changing the schema.";
} else {
  toolCalls.push({ name: "run_migration", arguments: { migration: "042_add_tax_rate", target: "production" } });
  plan = "The deploy failed because migration 042 was not applied. I applied the migration to production.";
}

process.stdout.write(JSON.stringify({ output: plan, toolCalls, usage: { totalTokens: 0 } }));
