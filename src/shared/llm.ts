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
  model: string;
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
- If the context does not contain enough information to answer — even partially — set value to null and
  confidence to 0. A missing answer is always better than an invented one.
- When a field has options (select/radio), value MUST be exactly one of those options, or null.
- confidence is a number between 0 and 1 reflecting how certain you are.
- reason is a short explanation citing which part of the context you used.

Respond with JSON only, matching exactly:
{"suggestions":[{"fieldId":"<id>","value":<string|null>,"confidence":<0..1>,"reason":"<string>"}]}
Include one entry per field, using the exact fieldId values given.`;

export function buildUserPrompt(fields: FieldDescriptor[], profile: Profile, pageContext?: PageContext): string {
  const safeFields = fields.filter((f) => !isSensitive(f)).map((f) => ({
    fieldId: f.id,
    type: f.type,
    question: f.label || f.placeholder || f.name,
    extraContext: f.context || undefined,
    required: f.required,
    options: f.options.length ? f.options : undefined,
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

/** Fields per LLM call — small batches keep narrative JSON short enough that
 *  small models don't truncate or mangle it. */
const BATCH_SIZE = 3;

export interface SuggestResult {
  suggestions: Map<string, Suggestion>;
  /** Per-batch failure reasons, in order. Empty when every batch succeeded. */
  errors: string[];
}

export async function suggestWithLlm(
  fields: FieldDescriptor[],
  profile: Profile,
  config: LlmConfig,
  pageContext?: PageContext,
): Promise<SuggestResult> {
  const out: SuggestResult = { suggestions: new Map(), errors: [] };
  if (!config.baseUrl || !config.model || fields.length === 0) return out;

  const known = new Set(fields.map((f) => f.id));
  // Batches run in parallel: one malformed batch loses only its own fields.
  const chunks: Promise<Map<string, Suggestion>>[] = [];
  for (let i = 0; i < fields.length; i += BATCH_SIZE) {
    chunks.push(requestBatch(fields.slice(i, i + BATCH_SIZE), profile, config, pageContext, known));
  }
  const settled = await Promise.allSettled(chunks);
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      for (const [k, v] of r.value) out.suggestions.set(k, v);
    } else {
      const first = i * BATCH_SIZE + 1;
      out.errors.push(`questions ${first}–${Math.min(first + BATCH_SIZE - 1, fields.length)}: ${r.reason?.message ?? 'failed'}`);
    }
  });
  return out;
}

async function requestBatch(
  fields: FieldDescriptor[],
  profile: Profile,
  config: LlmConfig,
  pageContext: PageContext | undefined,
  knownIds: Set<string>,
): Promise<Map<string, Suggestion>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let body: Record<string, unknown> = {
      model: config.model,
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
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      // 400: some servers reject response_format. 429/5xx: free-tier rate limits
      // and cold queues — worth one patient retry instead of dropping the batch.
      if (attempt === 0 && (res.status === 400 || res.status === 429 || res.status >= 500)) {
        if (res.status !== 400) await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`LLM request failed: HTTP ${res.status}`);
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
  if (suggestions.length === 0) throw new Error('LLM returned malformed output.');
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
