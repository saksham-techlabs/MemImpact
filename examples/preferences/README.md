# Example: answer-style preference

Memory under test: **"User prefers concise answers."**
Task: **"Explain Docker."**

This example uses the deterministic `fixture` runner, so it runs offline, needs no
API key and always produces the same report. The fixture stands in for a model:
it returns a short answer when the concise preference is in memory, and a longer,
sectioned answer otherwise. The long answer has two phrasings that alternate
between repetitions, which simulates ordinary run-to-run variation and shows how
MemImpact measures a noise floor.

```bash
# from the repository root, after `npm run build`
node dist/cli/main.js run -c examples/preferences/memimpact.config.json
```

The variants:

| Variant | Change | Expected |
| --- | --- | --- |
| `remove-answer-style` | remove the preference | at least MEDIUM |
| `prefer-detailed` | replace it with "User prefers detailed answers with examples." | at least MEDIUM |
| `remove-location` | remove an unrelated memory | at most LOW |

Each variant declares an `expect` block, so the command exits with code `1` if an
impact level falls outside what you expected. That makes the config usable as a
regression test in CI.

To try the same experiment against a real model, replace `runner` with an
`openai-compatible` runner (see `examples/openai-compatible/`) and keep
`repetitions` at 3 or more.
