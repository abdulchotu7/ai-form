import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS, migrateSettings, providerById, resolveLlmConfig, extractModelIds } from './providers';
import { emptyProfile, emptySettings } from './schema';
import { suggestWithLlm } from './llm';
import type { FieldDescriptor } from './types';

afterEach(() => vi.unstubAllGlobals());

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: 'f0', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '', ...partial };
}

describe('PROVIDERS registry', () => {
  it('contains the providers in order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['groq', 'nvidia', 'cerebras', 'ollama', 'custom']);
  });

  it('every provider is a single entry with id/label/endpoint/models/keyEnvVar/keyOptional', () => {
    for (const p of PROVIDERS) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.label).toBe('string');
      expect(typeof p.endpoint).toBe('string');
      expect(Array.isArray(p.models)).toBe(true);
      expect(p.keyEnvVar.startsWith('VITE_')).toBe(true);
      expect(typeof p.keyOptional).toBe('boolean');
    }
    expect(PROVIDERS.find((p) => p.id === 'custom')?.models).toEqual([]);
  });

  it('providerById falls back to the default provider for unknown ids', () => {
    expect(providerById('made-up').id).toBe('nvidia');
  });
});

describe('migrateSettings', () => {
  it('parses the new shape unchanged', () => {
    const stored = { providerId: 'groq', model: 'llama-3.3-70b-versatile', keys: { groq: 'g-key' } };
    const out = migrateSettings(stored, {});
    expect(out.providerId).toBe('groq');
    expect(out.model).toBe('llama-3.3-70b-versatile');
    expect(out.keys.groq).toBe('g-key');
  });

  it('migrates legacy settings with a known endpoint: infers provider, keeps model and key', () => {
    const out = migrateSettings(
      { llmBaseUrl: 'https://integrate.api.nvidia.com/v1/', llmApiKey: 'nv-1', llmModel: 'meta/llama-3.1-8b-instruct' },
      {},
    );
    expect(out.providerId).toBe('nvidia'); // trailing slash tolerated
    expect(out.model).toBe('meta/llama-3.1-8b-instruct'); // no data loss
    expect(out.keys.nvidia).toBe('nv-1');
  });

  it('migrates legacy settings with an unknown endpoint to Custom Provider, preserving everything', () => {
    const out = migrateSettings(
      { llmBaseUrl: 'https://vllm.internal:8080/v1', llmApiKey: 'vk-9', llmModel: 'my-custom-model' },
      {},
    );
    expect(out.providerId).toBe('custom');
    expect(out.customEndpoint).toBe('https://vllm.internal:8080/v1');
    expect(out.customApiKey).toBe('vk-9');
    expect(out.model).toBe('my-custom-model');
  });

  it('keeps defaults for unconfigured legacy settings', () => {
    const out = migrateSettings({ llmBaseUrl: '', llmApiKey: '', llmModel: '' }, {});
    expect(out.providerId).toBe('nvidia');
    expect(out.customEndpoint).toBe('');
  });

  it('seeds a provider key from env only when that key is empty in storage', () => {
    const env = { VITE_GROQ_API_KEY: 'env-key' };
    // Empty in storage → seeded.
    expect(migrateSettings({ providerId: 'groq', model: 'llama-3.1-8b-instant' }, env).keys.groq).toBe('env-key');
    // Saved at runtime → wins, env does not override.
    expect(migrateSettings({ providerId: 'groq', model: 'llama-3.1-8b-instant', keys: { groq: 'stored-key' } }, env).keys.groq)
      .toBe('stored-key');
  });

  it('seeds the custom provider key into customApiKey (not the dead keys.custom slot)', () => {
    const env = { VITE_CUSTOM_API_KEY: 'ck-env' };
    expect(migrateSettings({ providerId: 'custom', model: 'm', customEndpoint: 'http://x/v1' }, env).customApiKey).toBe('ck-env');
    expect(migrateSettings({ providerId: 'custom', model: 'm', customEndpoint: 'http://x/v1', customApiKey: 'stored' }, env).customApiKey)
      .toBe('stored');
    expect(migrateSettings({ providerId: 'custom', model: 'm', customEndpoint: 'http://x/v1' }, env).keys.custom).toBeUndefined();
  });

  it('returns defaults for garbage storage', () => {
    expect(migrateSettings(42, {})).toEqual(emptySettings());
  });
});

describe('extractModelIds', () => {
  it('extracts ids from standard OpenAI format ({ data: [{ id: "m" }] })', () => {
    expect(extractModelIds({ data: [{ id: 'model-a' }, { id: 'model-b' }] })).toEqual(['model-a', 'model-b']);
  });

  it('extracts names from Ollama/LMStudio format ({ models: [{ name: "m" }] })', () => {
    expect(extractModelIds({ models: [{ name: 'ollama-1' }, { name: 'ollama-2' }] })).toEqual(['ollama-1', 'ollama-2']);
  });

  it('extracts from top-level arrays of objects or strings', () => {
    expect(extractModelIds([{ id: 'arr-1' }, { id: 'arr-2' }])).toEqual(['arr-1', 'arr-2']);
    expect(extractModelIds(['str-1', 'str-2'])).toEqual(['str-1', 'str-2']);
  });

  it('returns empty array for invalid input', () => {
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds({})).toEqual([]);
    expect(extractModelIds(123)).toEqual([]);
  });
});

describe('resolveLlmConfig', () => {
  it('uses the curated endpoint and per-provider key', () => {
    const cfg = resolveLlmConfig({ ...emptySettings(), providerId: 'groq', model: 'allam-2-7b', keys: { groq: 'g-key' } });
    expect(cfg).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'g-key', model: 'allam-2-7b', providerId: 'groq' });
  });

  it('uses customEndpoint/customApiKey for the custom provider', () => {
    const cfg = resolveLlmConfig({
      ...emptySettings(),
      providerId: 'custom',
      model: 'my-model',
      customEndpoint: 'http://localhost:11434/v1',
      customApiKey: 'ck-1',
    });
    expect(cfg).toEqual({ baseUrl: 'http://localhost:11434/v1', apiKey: 'ck-1', model: 'my-model', providerId: 'custom' });
  });

  it('default settings resolve to the NVIDIA endpoint and default model', () => {
    const cfg = resolveLlmConfig(emptySettings());
    expect(cfg.baseUrl).toBe('https://integrate.api.nvidia.com/v1');
    expect(cfg.model).toBe('openai/gpt-oss-20b');
  });

  it('a fill uses the selected provider endpoint, key and model (mocked fetch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ fieldId: 'f1', value: '5', confidence: 0.9 }] }) } }] }),
    )));
    const settings = { ...emptySettings(), providerId: 'groq', model: 'llama-3.3-70b-versatile', keys: { groq: 'groq-key' } };
    const { suggestions } = await suggestWithLlm([field({ id: 'f1', label: 'Years' })], emptyProfile(), resolveLlmConfig(settings));
    expect(suggestions.get('f1')?.value).toBe('5');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer groq-key' });
    expect(JSON.parse((init as RequestInit).body as string).model).toBe('llama-3.3-70b-versatile');
  });
});
