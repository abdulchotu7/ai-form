import type { FieldDescriptor, LlmParsedResponse, PageContext, Profile, Suggestion } from './types';
import { LlmResponseSchema } from './schema';
import { isSensitive } from './match';

/**
 * Provider-agnostic LLM client. Speaks the OpenAI-compatible
 * /chat/completions protocol, so it works with OpenAI, vLLM, SGLang,
 * Ollama, LM Studio, etc. Endpoint config lives in user settings,
 * never in source code.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  /** One model, or comma-separated spares: "m1, m2". When a model keeps
   *  returning 429 after its patient retry (free-tier per-model caps, e.g.
   *  Groq), the next spare is tried with the same fields. */
  model: string;
  /** Provider identity that produced this config (for pacing decisions). */
  providerId?: string;
}

/** Validate that Provider and Model are present before a fill. Returns a
 *  human-readable message or null when valid. */
export function validateLlmConfig(config: LlmConfig): string | null {
  if (!config.baseUrl) return 'Select a Provider in Settings before filling — missing endpoint.';
  if (!config.model) return 'Select a Model in Settings before filling — missing model.';
  return null;
}

const SYSTEM_PROMPT = `You are a form-filling assistant. You receive:
1. "fields": web form fields with their labels, types and options.
2. "context": the user's personal information.

Rules:
- Use ONLY the provided context as your source of facts. NEVER invent, guess, or fabricate information.
- "pageInfo" describes the page the form is on (often a job posting). You MAY reference it when a
  question is about the specific role or company (e.g. "Why do you want to work here?"), combining it
  with the user's documents — but every claim about the company must come from pageInfo itself.
- "documents.resume" and "documents.portfolio" contain the user's full resume and portfolio text —
  mine them for projects, metrics, dates, and skills when composing answers.
- You MAY compose and synthesize answers from the context: summarize work experience into a professional
  summary, combine education entries into a narrative, list relevant skills for a specific question, or
  derive an answer that follows from the facts (e.g., years of experience from employment dates).
  Every fact in a composed answer must be traceable to the context. For composed multi-sentence answers,
  keep confidence at or below 0.85 and say in "reason" which context you synthesized it from.
- Some fields carry a "suggestedAnswer" — a candidate matched from the user's saved profile by exact
  label rules. Treat it as a HINT, not the truth: confirm it if the question genuinely asks for that
  data, correct it when the mapping is off (e.g. "current" vs "expected" compensation, first name vs
  full name), or return null when the question asks for something else entirely. Say in "reason" which
  you did (confirmed / corrected / rejected).
- If the context does not contain enough information to answer — even partially — set value to null and
  confidence to 0. A missing answer is always better than an invented one.
- When a field has options (select/radio), value MUST be exactly one of those options, or null.
- confidence is a number between 0 and 1 reflecting how certain you are.
- reason is a short explanation citing which part of the context you used.

Respond with JSON only, matching exactly:
{"suggestions":[{"fieldId":"<id>","value":<string|null>,"confidence":<0..1>,"reason":"<string>"}]}
Include one entry per field, using the exact fieldId values given.`;

export function buildUserPrompt(
  fields: FieldDescriptor[],
  profile: Profile,
  pageContext?: PageContext,
  /** Deterministic profile-match candidates — the LLM verifies or corrects
   *  these rather than answering blind. Keyed by fieldId. */
  hints?: Map<string, string>,
): string {
  const hintFor = (id: string) => hints?.get(id);
  const safeFields = fields.filter((f) => !isSensitive(f)).map((f) => ({
    fieldId: f.id,
    type: f.type,
    question: f.label || f.placeholder || f.name,
    extraContext: f.context || undefined,
    required: f.required,
    options: f.options.length ? f.options : undefined,
    // A candidate answer already matched from the user's profile. Confirm it
    // if the question truly asks for this data, correct it if the mapping is
    // wrong (e.g. "current" vs "expected" salary), or replace with null.
    suggestedAnswer: hintFor(f.id),
  }));
  // ponytail: 8k chars per document — fits any 2-page resume, keeps prompts fast.
  // Raise the cap if resumes grow or latency stops mattering.
  const CAP = 8_000;
  const context = {
    ...profile,
    documents: {
      resume: profile.documents?.resume?.slice(0, CAP) ?? '',
      portfolio: profile.documents?.portfolio?.slice(0, CAP) ?? '',
    },
  };
  return JSON.stringify({
    ...(pageContext?.title || pageContext?.description ? { pageInfo: pageContext } : {}),
    fields: safeFields,
    context,
  }, null, 1);
}

/** Strip markdown fences some models wrap around JSON. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : trimmed;
  return JSON.parse(raw);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Live model list from any OpenAI-compatible endpoint (GET /models). */
export async function fetchAvailableModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const ids = Array.isArray((data as { data?: unknown })?.data)
      ? ((data as { data: { id?: unknown }[] }).data)
        .map((m) => String(m?.id ?? ''))
        .filter(Boolean)
      : [];
    return [...new Set(ids)].sort();
  } catch {
    return [];
  }
}

/** Fields per LLM call, split by expected ANSWER size — the constraint is the
 *  output budget (max_tokens 2048), not input. Short answers ("Yes", "5") cost
 *  ~20 tokens each, so a dozen fit safely in one request; narrative answers
 *  cost 150–300 tokens each and degrade small-model JSON past three. */
const SHORT_BATCH_SIZE = 12;
const NARRATIVE_BATCH_SIZE = 3;

export function splitBatches(fields: FieldDescriptor[]): FieldDescriptor[][] {
  const short = fields.filter((f) => f.type !== 'textarea');
  const narrative = fields.filter((f) => f.type === 'textarea');
  const out: FieldDescriptor[][] = [];
  for (let i = 0; i < short.length; i += SHORT_BATCH_SIZE) out.push(short.slice(i, i + SHORT_BATCH_SIZE));
  for (let i = 0; i < narrative.length; i += NARRATIVE_BATCH_SIZE) out.push(narrative.slice(i, i + NARRATIVE_BATCH_SIZE));
  return out;
}

/** Free tiers like Groq cap tokens-per-minute hard and per MODEL (gpt-oss-20b:
 *  8k TPM; llama-3.1-8b-instant: its own separate, larger pool). Every request
 *  re-ships the full profile+documents context (~16k tokens), so on those
 *  endpoints two requests inside the same minute cannot fit under one cap.
 *  There we pace requests AND rotate across the model list — each model draws
 *  from its own limit, which multiplies effective throughput. Other providers
 *  run parallel with a single model. */
export function needsPacing(providerIdOrUrl: string): boolean {
  // Provider identity takes precedence — after the registry move the raw URL
  // is derived from the provider, so groq pacing must survive provider switches.
  if (providerIdOrUrl === 'groq') return true;
  try {
    return /(^|\.)groq\.com$/i.test(new URL(providerIdOrUrl).hostname);
  } catch {
    return false;
  }
}

/** Groq free-tier fallback chain, best-first. gpt-oss-20b writes the best
 *  narrative JSON; llama-3.1-8b-instant has the biggest free pool (separate
 *  TPM bucket); allam-2-7b is the last resort. Non-Groq endpoints ignore this
 *  and use the user's configured model for everything. */
export const GROQ_MODEL_CHAIN = [
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
  'allam-2-7b',
];

/** Gap between consecutive requests on paced (tight-TPM) endpoints. */
export const BATCH_GAP_MS = 15_000;

/** Backoff before the one retry on 429/5xx (tests stub this). */
export const RETRY_BACKOFF_MS = { value: 30_000 };

export interface SuggestResult {
  suggestions: Map<string, Suggestion>;
  /** Per-batch failure reasons, in order. Empty when every batch succeeded. */
  errors: string[];
  /** Set when rate limits forced some answers onto a spare model. */
  fallbackNotice?: string;
}

export async function suggestWithLlm(
  fields: FieldDescriptor[],
  profile: Profile,
  config: LlmConfig,
  pageContext?: PageContext,
  /** Deterministic profile-match candidates keyed by fieldId — shipped as
   *  "suggestedAnswer" hints the LLM confirms, corrects, or rejects. */
  hints?: Map<string, string>,
): Promise<SuggestResult> {
  const out: SuggestResult = { suggestions: new Map(), errors: [] };
  if (fields.length === 0) return out;
  const validation = validateLlmConfig(config);
  if (validation) throw new Error(validation);

  const known = new Set(fields.map((f) => f.id));
  // Short-answer fields go out as few big requests; textareas (narrative
  // JSON) stay in small ones. Paced endpoints (tight free-tier TPM, e.g.
  // Groq) run sequentially with a gap so the per-minute token budget is
  // never tripped by concurrency; everyone else runs fully parallel. A 429
  // still triggers the patient retry inside requestBatch either way.
  const chunks = splitBatches(fields);
  const paced = needsPacing(config.providerId ?? config.baseUrl);
  let rotated = 0;
  const runChunk = (chunk: FieldDescriptor[]): Promise<void> =>
    requestBatch(chunk, profile, config, pageContext, known, hints).then(({ suggestions: result, usedSpare }) => {
      if (usedSpare) rotated++;
      for (const [k, v] of result) out.suggestions.set(k, v);
    }).catch((e: unknown) => {
      const first = fields.indexOf(chunk[0]) + 1;
      out.errors.push(`questions ${first}–${first + chunk.length - 1}: ${e instanceof Error ? e.message : 'failed'}`);
      return undefined;
    });
  if (paced) {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, BATCH_GAP_MS));
      await runChunk(chunks[i]);
    }
  } else {
    await Promise.all(chunks.map(runChunk));
  }
  if (rotated > 0) {
    const chain = modelChain(config.model);
    out.fallbackNotice = `Rate limits hit on ${chain[0]} — ${rotated} request${rotated > 1 ? 's' : ''} used ${chain[1] ?? 'a spare model'} instead. You can switch models any time in Settings.`;
  }
  return out;
}

/** Models to try in order: "m1, m2" → ["m1", "m2"]. Whitespace-tolerant. */
export function modelChain(model: string): string[] {
  return model.split(',').map((m) => m.trim()).filter(Boolean);
}

async function requestBatch(
  fields: FieldDescriptor[],
  profile: Profile,
  config: LlmConfig,
  pageContext: PageContext | undefined,
  knownIds: Set<string>,
  hints?: Map<string, string>,
): Promise<{ suggestions: Map<string, Suggestion>; usedSpare: boolean }> {
  const chain = modelChain(config.model);
  let lastError: Error | null = null;
  for (let i = 0; i < chain.length; i++) {
    try {
      return { suggestions: await requestBatchWithModel(fields, profile, config, pageContext, knownIds, chain[i], hints), usedSpare: i > 0 };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new Error('LLM request failed.');
}

async function requestBatchWithModel(
  fields: FieldDescriptor[],
  profile: Profile,
  config: LlmConfig,
  pageContext: PageContext | undefined,
  knownIds: Set<string>,
  model: string,
  hints?: Map<string, string>,
): Promise<Map<string, Suggestion>> {
  let lastDetail = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let body: Record<string, unknown> = {
      model,
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        // Documents are big (8k chars each) — only ship them to batches that
        // actually need narrative context (textareas).
        {
          role: 'user',
          content: buildUserPrompt(
            fields,
            // Documents are big (8k chars each) — ship them only to batches
            // that can actually use narrative context: free-text answers
            // (single-line text inputs often ask "tell us about your
            // experience" too) and selects/radios where an option must be
            // composed from the documents.
            fields.some((f) => f.type === 'textarea' || f.type === 'text')
              ? profile
              : { ...profile, documents: { resume: '', portfolio: '' } },
            pageContext,
            hints,
          ),
        },
      ],
    };

    if (attempt === 1) {
      // Some OpenAI-compatible servers reject response_format; retry without it.
      body.response_format = undefined;
    }
    const res = await fetch(`${normalizeBaseUrl(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      // Bound worst-case hangs; queued endpoints can stall far longer than
      // a good run (~5–15s). Better a retryable failure than a frozen panel.
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      // Try to surface the provider's error message (e.g. model_not_found)
      // so the user sees *why* it failed instead of a bare HTTP status.
      let detail = '';
      try {
        const body = await res.clone().json() as { error?: unknown };
        const e = body?.error;
        if (typeof e === 'string') detail = e;
        else if (e && typeof e === 'object' && 'message' in e) detail = String((e as { message: unknown }).message);
        else if (e && typeof e === 'object') detail = JSON.stringify(e).slice(0, 300);
      } catch {
        try { detail = (await res.clone().text()).slice(0, 300); } catch { /* ignore */ }
      }
      const msg = detail ? `${detail} (HTTP ${res.status})` : `LLM request failed: HTTP ${res.status}`;
      // 400: some servers reject response_format. 429: free-tier rate limits
      // (Groq's is per-minute tokens) — wait out the server's own retry hint,
      // then one patient retry. 5xx: cold queues, worth the same retry.
      if (attempt === 0 && (res.status === 400 || res.status === 429 || res.status >= 500)) {
        if (res.status !== 400) {
          const retryHint = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(retryHint) && retryHint > 0 ? retryHint * 1000 : RETRY_BACKOFF_MS.value;
          await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
        } else {
          // For 400, keep the detail for the final error — don't swallow it.
          lastDetail = msg;
        }
        continue;
      }
      throw new Error(lastDetail || msg);
    }
    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    return finalize(content, knownIds);
  }
  throw new Error('unreachable');
}

function finalize(content: string, knownIds: Set<string>): Map<string, Suggestion> {
  const out = new Map<string, Suggestion>();
  let suggestions: LlmParsedResponse['suggestions'] | null = null;
  try {
    const r = LlmResponseSchema.safeParse(extractJson(content));
    if (r.success) suggestions = r.data.suggestions;
  } catch {
    // fall through to salvage
  }
  if (!suggestions) {
    // Salvage: broken/truncated JSON — recover whatever well-formed
    // suggestion objects exist instead of losing them all.
    suggestions = [];
    for (const m of content.matchAll(/\{[^{}]*"fieldId"[^{}]*\}/g)) {
      try {
        const r = LlmResponseSchema.safeParse({ suggestions: [JSON.parse(m[0])] });
        if (r.success) suggestions.push(...r.data.suggestions);
      } catch {
        // skip unrecoverable fragment
      }
    }
  }
  // An explicitly empty suggestion list is a VALID response ("no answer for
  // these") — only total garbage (unparseable AND nothing salvageable) is an
  // error worth rotating models for.
  if (!suggestions) throw new Error('LLM returned malformed output.');
  for (const s of suggestions) {
    if (!knownIds.has(s.fieldId)) continue; // reject hallucinated field ids
    const value = s.value?.trim() ? s.value.trim() : null;
    // Enforce the "composed answers ≤ 0.85" rule in code — small models
    // routinely ignore it in the prompt. LLM output is fallback-only
    // (deterministic matches win), so this never downgrades a direct match.
    out.set(s.fieldId, {
      fieldId: s.fieldId,
      value,
      confidence: Math.min(s.confidence ?? 0, 0.85),
      source: 'llm',
      reason: s.reason ?? '',
    });
  }
  return out;
}
