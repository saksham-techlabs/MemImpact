# Example: real models via OpenAI-compatible endpoints (BYOK)

These configs call a real model. They are **not** run by the test suite. You
supply the endpoint, the model and (for hosted providers) your own API key.

## Local model (no key, nothing leaves your machine)

`ollama.config.json` targets [Ollama](https://ollama.com)'s OpenAI-compatible
endpoint at `http://localhost:11434/v1`. Any local server that implements
`POST /v1/chat/completions` works the same way, for example llama.cpp server,
LM Studio or vLLM.

```bash
ollama pull llama3.2
memimpact run -c examples/openai-compatible/ollama.config.json
```

## Hosted provider (your own key)

`hosted.config.json` uses `apiKeyEnv` to name the environment variable that
holds **your** key. The key itself never appears in the config, in run
artifacts or in reports.

```bash
# macOS / Linux
export MEMIMPACT_API_KEY="<your key>"
# Windows PowerShell
$env:MEMIMPACT_API_KEY = "<your key>"

memimpact run -c examples/openai-compatible/hosted.config.json
```

Replace `YOUR_MODEL_NAME` with a model your account can use. For other
OpenAI-compatible providers, change `baseUrl`, and optionally `apiKeyEnv`,
to match that provider.

When the endpoint is not `localhost`, MemImpact prints a notice before running.
The notice says that the task and memory content will be sent to that provider.
This config also sets `artifacts.storeMemoryContent: false`, so saved artifacts
contain hashes instead of memory text.

Notes:

- `temperature: 0` and `seed` reduce variation, but not every provider honours
  them, and even then outputs are not guaranteed to be identical.
  Keep `repetitions` at 3 or more.
- A full run makes `repetitions × (1 + number of variants)` requests.
  This config makes 3 × 2 = 6 requests. Each request is billed by your
  provider.
