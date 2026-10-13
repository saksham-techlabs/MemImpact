# Security policy

## Supported versions

MemImpact is pre-1.0. Security fixes are made on the latest released version only.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
private vulnerability reporting ("Report a vulnerability" under the
repository's **Security** tab) once the repository is public. Include steps to
reproduce, the affected version and the impact you expect.

You should receive an acknowledgement within a few days. Please allow a
reasonable time for a fix before you disclose the issue publicly.

## Security model

MemImpact is a local CLI that runs experiments you configure. It is designed
around these properties:

### Secrets

- **API keys are read only from environment variables.** The config refers to
  a key by its variable *name* (`runner.apiKeyEnv`), never by value.
- Validation rejects configs that contain:
  - string values that look like credentials (`sk-…`, `ghp_…`, `github_pat_…`,
    `AIza…`, `xox?-…`, `AKIA…`, `hf_…`, `Bearer …`)
  - credential headers (`Authorization`, `x-api-key`, `api-key`, `cookie`,
    or any header whose name contains KEY/TOKEN/SECRET/PASSWORD/…)
  - secret-named variables in the command runner's `env`
- **Redaction.** Before anything is printed or written to disk, MemImpact
  replaces these values with `[REDACTED]`:
  - the value of the configured key variable
  - the value of every environment variable whose name contains KEY, TOKEN,
    SECRET, PASSWORD, PASSWD, CREDENTIAL or AUTH (values of 8+ characters)
  - the credential formats listed above

  This covers console output, `--json` output, run artifacts and error messages.
- Keys are never included in run artifacts. Artifacts store the endpoint
  origin and path, but no query string and no credentials.

Redaction is defence in depth, not a guarantee. A secret in an unusual format
that is not stored in an environment variable cannot be recognised. Do not put
secrets in memories or tasks.

### Process execution

- The command runner uses `child_process.spawn` with `shell: false`. Arguments
  are passed verbatim and are never interpreted by a shell.
- Each process has a timeout (`timeoutMs`, default 120 s) and a 10 MB stdout cap.
- The command you configure runs with your user's permissions. Only configure
  commands you trust. Treat a `memimpact.config.json` from an untrusted source
  like any other script you would run.

### No side effects

- MemImpact never executes tool calls proposed by a model. It only records
  and compares them.
- It never writes to your config, your memories file or any memory store,
  and it never pushes code or deploys anything.
- It makes no network requests except to the `baseUrl` of an
  `openai-compatible` runner that you configured.

## Never commit secrets

- Keep keys in your shell environment or a secret manager. `.env` files are
  git-ignored in this repository; use the same rule in yours.
- `.memimpact/` artifacts can contain memory content and model outputs. The
  directory contains its own `.gitignore` with `*`, so it is excluded from git
  by default.
