# AI Form Assistant — Engineering Rules

## Status: MVP v0.1.0 — COMPLETE & VERIFIED (built + tested in real Chromium)

The full vertical slice works end to end. Verified by 88 unit tests (vitest + happy-dom)
and a 29-check e2e suite (`npm run e2e`) that loads `dist/` into Brave/Chromium and drives
the actual extension through its service worker.

### What exists

- **No backend.** The side panel calls any OpenAI-compatible `/chat/completions` endpoint
  directly. Defaults target NVIDIA's API (`https://integrate.api.nvidia.com/v1`) with
  `meta/llama-3.1-8b-instruct` — benchmark-chosen for speed (~2s vs 90s+ reasoning models,
  no quality loss for form filling). The key is injected at build time from a
  gitignored `.env` (`VITE_NVIDIA_API_KEY`) — never committed, never hard-coded.
  Users can override all three in the Settings tab (OpenAI / Ollama / vLLM / SGLang).
  Client fetch timeout is 90s (default model answers in ~2s).
- **LLM builds context:** the system prompt lets the model synthesize/compose answers
  (professional summaries, narratives) strictly from profile facts — including the
  full resume + portfolio text in `profile.documents` (capped at 8k chars each in the prompt)
  — capped at confidence 0.85 for composed answers (enforced in code in `finalize()`, not
  just the prompt); anything not derivable stays null (no fabrication). Live tests live in
  `*.live.test.ts` and are EXCLUDED from `npm test`; run them with `npm run test:live`.
  File uploads are NEVER filled — the user attaches files manually (resume auto-attach
  was removed by user decision).
- **Trusted-input filling (critical invariant):** synthetic input events are
  `isTrusted:false` and some frameworks' validators never accept them — the DOM shows the
  value but the page's own state still thinks the field is empty ("required" errors on
  submit even though content is visible). So ALL free-text fields (input/textarea) are
  retyped via chrome.debugger CDP `Input.insertText` (real trusted keystrokes) after the
  initial synthetic write, then verified READ-ONLY (`AF_FILL` + `verifyOnly` → `verifyFill`
  in fill.ts) — never re-written with synthetic events after trusted input, which would
  clobber the framework state the keystrokes just fixed. Selects/radios/checkboxes don't
  need this (click/change works there).
- **Stack:** TypeScript strict, Vite 6 (3 configs: sidepanel React app, content IIFE,
  background IIFE), React 18, zod for all boundary validation, vitest + happy-dom,
  Playwright (`playwright-core`) for e2e.
- **Layout:**
  - `src/shared/` — pure logic: `types.ts` (FieldDescriptor/Suggestion/message contracts),
    `schema.ts` (zod), `match.ts` (alias table, sensitive detection, derivations),
    `llm.ts` (provider-agnostic client).
  - `src/content/` — `detect.ts` (DOM → normalized fields; label resolution via label/
    ARIA/placeholder/table-header/name), `fill.ts` (the ONLY code touching page DOM;
    native-setter writes + input/change events so React/Vue/Angular work), `index.ts`
    (messaging + debounced MutationObserver staleness counter).
  - `src/sidepanel/` — React tabs: Form (analyze/review/fill), Profile (incl. Context
    Documents: resume + portfolio text, with .txt/.md file import), Settings.
  - `context/` — user's source material: resume PDFs + extracted .txt versions,
    portfolio URL + extracted text. These get pasted/loaded into the extension's
    Profile → Context Documents once and persist in chrome.storage.
  - `scripts/e2e.mjs`, `public/test/form-a.html` + `form-b.html` (local test forms).
- **Key invariants (do not regress):**
  - Field ids are STABLE PER ELEMENT (module-level WeakMap in detect.ts) — positional ids
    broke fills when dynamic DOM shifted between Analyze and Fill. Regression-tested.
  - Sensitive fields are filtered from LLM prompts AND refused at fill time.
  - LLM output is zod-validated; unknown fieldIds dropped; no eval anywhere.
  - Fill = exactly 4 ops: set value / select option / check radio / toggle checkbox.
  - Never submit, never navigate, never click buttons.

### Commands

```bash
npm run build      # typecheck + build → dist/ (load unpacked from here)
npm test           # unit tests (live-API tests excluded; run separately)
npm run test:live  # live NVIDIA round-trips (needs .env key)
npm run e2e        # real-browser verification via Playwright (Chrome for Testing
                   # auto-found in the Playwright cache, or Brave; headed mode)
npm run serve:test # test forms at http://localhost:8899/test/form-a.html
```

### Gotchas learned

- Chrome 137+ stable ignores `--load-extension` and blocks CDP on the default profile
  (port 9222 squatted, all endpoints 404). E2E uses Chrome for Testing (same engine,
  honors extensions; auto-discovered in the Playwright cache) or Brave via Playwright's
  `launchPersistentContext` (extensions require headed mode there).
- happy-dom's fetch enforces CORS — live-API tests must use `// @vitest-environment node`
  (the real extension bypasses CORS via host_permissions, so this is test-only).
- The test form's dynamic field inserts at the TOP paragraph — this is deliberate;
  it's what caught the id-shift bug.
- `checkVisibility` doesn't exist in happy-dom; detect.ts falls back gracefully.

## Goal

Build a privacy-conscious Chrome extension that helps users understand and fill arbitrary web forms using their personal context.

## Rules

* Use TypeScript and Chrome Extension Manifest V3.
* Prefer a simple, modular architecture.
* Never allow the LLM to execute arbitrary JavaScript or directly control the browser.
* LLMs return structured data; the extension validates and executes deterministic DOM operations.
* Never automatically submit forms.
* Never automatically fill sensitive fields such as passwords, payment information, government IDs, or authentication codes.
* Never fabricate user information. If context is insufficient, leave the field unresolved.
* Use confidence levels for AI-generated suggestions.
* Request minimum browser permissions.
* Do not send entire webpages to an LLM. Extract only relevant form information.
* Never hard-code API keys or provider-specific credentials.
* Keep the LLM provider replaceable so local models and API providers can be supported.
* Do not over-engineer the MVP. Prefer a working vertical slice over unnecessary abstractions.
* Before considering the project complete, run it and test the actual extension behavior.

## Development Principle

Build the simplest reliable system first:

```text
Webpage
→ Detect fields
→ Normalize fields
→ Match user context
→ LLM fallback when necessary
→ Validate suggestions
→ User review
→ Fill fields
→ User submits manually
```
