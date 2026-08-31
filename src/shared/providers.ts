import type { Settings } from './types';
import type { LlmConfig } from './llm';
import { emptySettings, SettingsSchema } from './schema';

/**
 * Curated Provider registry. Adding a Provider is a single entry here:
 * id/label/endpoint/models/keyEnvVar/keyOptional. `custom` is the sentinel
 * for self-hosted OpenAI-compatible servers — its Endpoint/Model/Key are
 * user-supplied free text stored in the settings shape, never curated.
 */
export interface Provider {
  id: string;
  label: string;
  endpoint: string;
  models: string[];
  keyEnvVar: string;
  keyOptional: boolean;
}

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    keyEnvVar: 'VITE_OPENAI_API_KEY',
    keyOptional: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'allam-2-7b'],
    keyEnvVar: 'VITE_GROQ_API_KEY',
    keyOptional: false,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    models: ['openai/gpt-oss-20b', 'meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-v3-675b'],
    keyEnvVar: 'VITE_NVIDIA_API_KEY',
    keyOptional: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    models: ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral', 'gemma2'],
    keyEnvVar: 'VITE_OLLAMA_API_KEY',
    keyOptional: true,
  },
  {
    id: 'custom',
    label: 'Custom Provider',
    endpoint: '',
    models: [],
    keyEnvVar: 'VITE_CUSTOM_API_KEY',
    keyOptional: true,
  },
];

/** Unknown/blank ids resolve to the default provider so bad storage never breaks fills. */
export function providerById(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS.find((p) => p.id === 'nvidia')!;
}

const normalizeEndpoint = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** Vite env (import.meta.env) guard — absent in non-Vite test/Node contexts. */
function readEnv(): Record<string, string | undefined> {
  if (typeof import.meta === 'undefined') return {};
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env ?? {};
}

const isLegacyShape = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && 'llmBaseUrl' in raw;

/**
 * Storage → Settings. Handles the flat `{ llmBaseUrl, llmApiKey, llmModel }`
 * shape saved by pre-provider builds (additive migration, no data loss), then
 * seeds per-Provider keys from `VITE_<PROVIDER>_API_KEY` — but only when that
 * key is empty in storage, so runtime edits win without a rebuild.
 */
export function migrateSettings(
  raw: unknown,
  env: Record<string, string | undefined> = readEnv(),
): Settings {
  let s: Settings;
  if (isLegacyShape(raw)) {
    s = migrateLegacy(raw);
  } else {
    const parsed = SettingsSchema.safeParse(raw);
    s = parsed.success ? parsed.data : emptySettings();
  }
  for (const p of PROVIDERS) {
    const seeded = env[p.keyEnvVar]?.trim();
    if (!seeded) continue;
    // The custom provider's key lives in customApiKey (never keys.custom).
    if (p.id === 'custom') {
      if (!s.customApiKey) s.customApiKey = seeded;
    } else if (!s.keys[p.id]) {
      s.keys[p.id] = seeded;
    }
  }
  return s;
}

function migrateLegacy(raw: unknown): Settings {
  const r = raw as { llmBaseUrl?: unknown; llmApiKey?: unknown; llmModel?: unknown };
  const baseUrl = String(r.llmBaseUrl ?? '').trim();
  const apiKey = String(r.llmApiKey ?? '').trim();
  const model = String(r.llmModel ?? '').trim();
  const base = emptySettings();

  const matched = PROVIDERS.find(
    (p) => p.endpoint && normalizeEndpoint(p.endpoint) === normalizeEndpoint(baseUrl),
  );
  if (matched) {
    // Known endpoint → infer the Provider, keep the legacy model and key.
    return {
      ...base,
      providerId: matched.id,
      model: model || matched.models[0] || '',
      keys: apiKey ? { [matched.id]: apiKey } : {},
    };
  }
  if (!baseUrl) {
    // Never really configured — fall back to defaults, keep any key.
    return { ...base, keys: apiKey ? { nvidia: apiKey } : {} };
  }
  // Unknown endpoint → Custom Provider preserving the raw Endpoint/Model/Key.
  return { ...base, providerId: 'custom', model, customEndpoint: baseUrl, customApiKey: apiKey };
}

/** The actual LLM config a fill uses: provider endpoint, per-provider key, single model. */
export function resolveLlmConfig(s: Settings): LlmConfig {
  if (s.providerId === 'custom') {
    return { baseUrl: s.customEndpoint, apiKey: s.customApiKey, model: s.model, providerId: "custom" };
  }
  return { baseUrl: providerById(s.providerId).endpoint, apiKey: s.keys[s.providerId] ?? '', model: s.model, providerId: s.providerId };
}
