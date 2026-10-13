# Example: structured architecture decision

The agent answers with JSON:

```json
{ "database": "PostgreSQL", "hosting": "Vercel", "rationale": "...", "requestId": "req-001" }
```

MemImpact parses every output and compares each field's values across all
baseline and variant repetitions:

- `compare.decisionPaths` marks `database` and `hosting` as **decision fields**. A
  decision field that changes (no value shared between baseline and variant)
  makes the impact HIGH.
- `compare.ignorePaths` excludes `requestId`. It differs on every run, so
  comparing it would only add noise.
- `compare.structured: "always"` reports an explicit note if any output is not JSON.

```bash
node dist/cli/main.js run -c examples/structured-decision/memimpact.config.json
```

Excerpt of the report for `remove-db-preference`:

```text
━━ Variant: remove-db-preference
  Memory change:  Removed memory "database-preference"
  Impact:         HIGH
  ...
  Structured fields (JSON parsed in 3/3 baseline, 3/3 variant runs)
    database    CHANGED   "PostgreSQL" → "MongoDB"
    hosting     UNCHANGED "Vercel"
    rationale   CHANGED   "Relational model ..." → "Flexible document model ..."
```

The `remove-team-size` variant is a control. The team-size memory is irrelevant
to the decision, so the expected impact is NONE.
