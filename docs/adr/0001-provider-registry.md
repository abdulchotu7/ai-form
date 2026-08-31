# Provider registry with curated Model picker

Settings previously exposed a raw `llmBaseUrl` text field plus a free-text `llmModel` and a single global `llmApiKey`. Users had to know endpoint URLs and model IDs by heart and paste them correctly. We replaced that with a curated **Provider → Model** picker backed by a hard-coded `PROVIDERS` registry in `src/shared/providers.ts`.

Each Provider defines its default Endpoint, whether an API key is required, its curated Models, and the `VITE_<PROVIDER>_API_KEY` env var that seeds `chrome.storage.local` on first run. A special **Custom Provider** keeps the old free-text Endpoint + Model for self-hosted or unlisted OpenAI-compatible servers. Settings migrate additively: existing `{ llmBaseUrl, llmModel, llmApiKey }` triples are inferred to a `providerId` on next load so no data is lost; the Model picker is single-select (no comma-separated fallback chain — the user switches manually via the dropdown when rate-limited).

We chose hard-coded constants over a separate `providers.json` file, and a hybrid env-seeds-storage key model over build-time-only keys, to keep the change minimal and type-safe while preserving the Custom escape hatch for local models (Ollama, vLLM, LM Studio).
