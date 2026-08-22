# AI Form Assistant

A Chrome extension (Manifest V3) that understands web forms and suggests answers from your personal context. You review every suggestion; nothing is filled without your approval; nothing is ever submitted automatically.

```
Webpage → detect fields → normalize → match against profile
        → LLM only for ambiguous fields → validate → you review → fill → you submit
```

## Features

- **Side panel UI** — profile editor (personal, contact, education, experience, skills, preferences, reusable standard answers), form analysis view with confidence indicators, settings.
- **Smart detection** — finds fields anywhere in the DOM (not just `<form>`), resolves labels from `<label>`, ARIA (`aria-label`, `aria-labelledby`, `aria-describedby`), placeholders, table headers, fieldset legends, and `name` attributes. Handles selects, radio groups, checkbox groups, textareas, dates.
- **Deterministic matching first** — email/phone/name/LinkedIn/GitHub/skills/relocation etc. are matched locally with an alias system; derived values (years of experience, highest education) are computed from your profile, never guessed.
- **LLM fallback** — ambiguous questions ("Why are you interested in this role?") go to any **OpenAI-compatible endpoint** (OpenAI, Ollama, vLLM, SGLang, LM Studio…). Responses are schema-validated; malformed or hallucinated output is rejected.
- **No fabrication** — if your profile can't answer a question, it's marked *unresolved*, never invented.
- **Sensitive-field safety** — passwords, card numbers, CVV, bank details, government IDs, OTPs and similar are detected and never filled or sent to the LLM.
- **Framework-safe filling** — values are set through native prototype setters with `input`/`change` events so React/Vue/Angular controlled inputs update correctly. Field ids are stable per element, so DOM mutations between Analyze and Fill can't misdirect fills.

## Project layout

```
src/
  shared/            # pure logic, fully unit-tested
    types.ts         # FieldDescriptor, Suggestion, message contracts
    schema.ts        # zod schemas: profile, settings, LLM response
    match.ts         # alias table, sensitive-field detection, derivations
    llm.ts           # provider-agnostic OpenAI-compatible client + prompts
  content/
    detect.ts        # DOM scanning → normalized FieldDescriptors
    fill.ts          # deterministic DOM filling (the only code that touches the page)
    index.ts         # messaging + MutationObserver staleness flag
  sidepanel/         # React app (profile / analysis / settings)
  background/        # service worker (opens the side panel)
scripts/e2e.mjs      # end-to-end verification in a real Chromium
public/test/         # local test forms (form-a, form-b)
```

## Getting started

```bash
npm install
npm run build          # typecheck + build → dist/
```

Then load it:

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder
4. Click the extension icon to open the side panel

### Try it

```bash
npm run serve:test     # serves dist/ at http://localhost:8899
```

1. Open the side panel → **Profile** → enter your info → Save
2. (Optional) **Settings** → point at an LLM endpoint, e.g. base URL `http://localhost:11434/v1`, model `llama3.1`
3. Visit `http://localhost:8899/test/form-a.html`
4. Side panel → **Analyze Form** → review/edit suggestions → **Fill All Approved**
5. Submit the form yourself — the extension never does

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server for the side panel (extension APIs unavailable) |
| `npm run watch` | Rebuild all three bundles on change |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm test` | Unit tests (vitest + happy-dom; live NVIDIA test auto-skips without `.env`) |
| `npx vitest run llm.live` | Live round-trip against NVIDIA's API (~2 min, needs `.env` key) |
| `npm run e2e` | Playwright loads `dist/` into real Chromium and verifies the full pipeline |
| `npm run serve:test` | Serve `dist/` at :8899 for the bundled test forms |

## Configuration

No backend required. Defaults target **NVIDIA's OpenAI-compatible endpoint**
(`integrate.api.nvidia.com`) with `meta/llama-3.1-8b-instruct` — chosen by benchmark:
it answers in ~2s where reasoning models took 90s+ with no quality gain for form filling.
The API key is read at build time from a gitignored `.env`:

```bash
cp .env.example .env   # then paste your key from https://build.nvidia.com
npm run build
```

Everything is overridable in the extension's **Settings** tab — any OpenAI-compatible
endpoint works: OpenAI, Ollama (`http://localhost:11434/v1`), vLLM/SGLang, LM Studio.
Without an endpoint/key the extension still works: deterministic matching
fills what it can and marks the rest unresolved.

## Privacy & security model

- Profile lives in `chrome.storage.local` on your machine.
- Only normalized field questions + your profile JSON go to the LLM — never raw HTML, never page content beyond the fields themselves. The LLM may compose/synthesize answers (summaries, narratives) but every fact must trace to your profile; composed answers are capped at 85% confidence.
- Sensitive fields are filtered out of LLM prompts entirely and refused at fill time.
- The LLM returns structured data that is zod-validated; unknown field ids are dropped. No `eval`, no arbitrary JS, no clicks, no navigation, no submission — the filler performs exactly four operations: set value, select option, check radio, toggle checkbox.

## Known limitations

- No automatic multi-page form support — analyze/fill per page.
- Label heuristics cover common layouts; exotic custom widgets (canvas-drawn, shadow-DOM-heavy) may need more work.
- Confidence comes from the matcher/LLM self-report, not calibration.
- Headless branded Chrome ignores `--load-extension`; the e2e script uses Brave/Chromium.

## What we'd build next

1. Per-site memory of reviewed answers ("always answer this question this way").
2. Multi-step form support (detect pagination, carry context).
3. Local-only mode with a small on-device model via WebLLM/Ollama enforced by default.
4. Import profile from resume PDF.
