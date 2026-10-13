# Contributing to MemImpact

Thanks for your interest in improving MemImpact.

## Development setup

You need Node.js 22 or newer.

```bash
npm install
npm run build
node dist/cli/main.js --help
```

## Quality gate

Run the full gate before you open a pull request:

```bash
npm run check
```

`check` runs these steps in order:

| Step | Command |
| --- | --- |
| Typecheck (strict, source + tests) | `npm run typecheck` |
| Lint (ESLint + typescript-eslint strict) | `npm run lint` |
| Tests (compiled, `node:test`) | `npm test` |
| Build | `npm run build` |
| Internal consistency (versions, schema ↔ code, every example config) | `npm run validate:internal` |
| Package smoke test (`npm pack`, install the tarball in a temp project, exercise the bin) | `npm run smoke` |

CI runs `npm run check` on Ubuntu, Windows and macOS with Node 22 and 24.

## Guidelines

- **No new runtime dependencies** without a strong reason. Built-in Node APIs
  are preferred.
- **Tests use real files and processes.** The command runner tests spawn real
  child processes. The OpenAI-compatible runner tests use a local
  `node:http` server. CLI tests run the compiled binary. Keep it that way, and
  avoid mocking everything.
- **Cross-platform.** Use `path.join`/`path.resolve`, avoid shell-specific
  behaviour, and remember that Windows paths contain `:` and `\`.
- **Never add real credentials**, even in tests. Use obviously fake values.
- **Do not overclaim.** Reports and docs must describe observed differences,
  not proven causation. If you change the impact rules, update
  [docs/impact.md](docs/impact.md) and the README in the same pull request.
- Keep the JSON Schema (`schema/`) in sync with the validator. The internal
  check verifies the type lists.

## Project layout

```
src/
  cli/          argument parsing, commands, help, init templates
  config/       loading and strict validation
  mutations/    remove / replace / modify / add on memory copies
  runners/      fixture, openai-compatible, command; prompt rendering
  experiments/  orchestration of baseline + variant runs
  compare/      diff, text, structured JSON, tool calls, terms, aggregation
  core/         impact classification, redaction, errors, version
  reporters/    human and JSON output
  storage/      local run artifacts
  types/        shared types
tests/          node:test suites (compiled to .test-build/)
examples/       runnable example experiments
docs/           reference documentation
schema/         JSON Schema for the config file
scripts/        build, test, validation and smoke helpers
```

## Commit messages

Use short imperative subjects, for example "Add tool-call argument diff".
Reference issues where relevant.
