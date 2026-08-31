# AI Form Assistant

A privacy-conscious Chrome extension that detects web form fields, resolves them against the user's saved profile, and fills them via validated LLM suggestions — the user always reviews and submits manually.

## Language

**Provider**: A named AI service offering an OpenAI-compatible `/chat/completions` endpoint (e.g., OpenAI, Groq, NVIDIA, Ollama). A Provider defines its default Endpoint, auth scheme, and curated Models.
_Avoid_: vendor, backend, baseUrl

**Endpoint**: The base URL of a Provider's OpenAI-compatible API (e.g., `https://api.openai.com/v1`).
_Avoid_: baseUrl, host, URL

**Model**: A model identifier scoped to a single Provider (e.g., `gpt-4o-mini` on OpenAI, `openai/gpt-oss-20b` on NVIDIA). The same string on different Providers is a different Model.
_Avoid_: engine, deployment

**Custom Provider**: A special Provider that lets the user supply an arbitrary Endpoint and Model for self-hosted or unlisted services (vLLM, SGLang, LM Studio). Its Endpoint and Model are free-text rather than chosen from a curated list.
_Avoid_: custom URL, bring-your-own endpoint

**Profile**: The user's saved personal context (personal, contact, education, experience, skills, documents) stored in `chrome.storage.local` and used as the source of facts for field resolution.
_Avoid_: context, user data

**Suggestion**: A validated fill value for one detected field, returned by the LLM with a confidence score. Only text fields are suggested; sensitive fields are never suggested.
_Avoid_: hint, completion
