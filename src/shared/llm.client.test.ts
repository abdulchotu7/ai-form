import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestWithLlm, BATCH_GAP_MS, RETRY_BACKOFF_MS } from './llm';
import type { FieldDescriptor, Profile } from './types';
import { emptyProfile } from './schema';

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: 'f0', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '', ...partial };
}

const config = { baseUrl: 'http://llm.test/v1', apiKey: 'sk-test', model: 'test-model' };

function mockFetch(responseBody: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe('suggestWithLlm', () => {
  const profile: Profile = emptyProfile();
  profile.experience.push({ company: 'Acme', title: 'Eng', startDate: '2020-01', endDate: 'Present', description: '', technologies: '' });

  it('parses a good response into suggestions keyed by fieldId', async () => {
    vi.stubGlobal('fetch', mockFetch({
      choices: [{ message: { content: JSON.stringify({ suggestions: [{ fieldId: 'f1', value: '5', confidence: 0.9, reason: 'dates' }] }) } }],
    }));
    const out = (await suggestWithLlm([field({ id: 'f1', label: 'Years of experience' })], profile, config)).suggestions;
    expect(out.get('f1')?.value).toBe('5');
    expect(out.get('f1')?.source).toBe('llm');
  });

  it('degrades gracefully on malformed JSON (returns empty, no throw)', async () => {
    vi.stubGlobal('fetch', mockFetch({ choices: [{ message: { content: 'sorry, I cannot' } }] }));
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, config)).suggestions;
    expect(out.size).toBe(0);
  });

  it('salvages valid suggestions from broken JSON', async () => {
    const broken = 'Here you go:\n{"suggestions": [{"fieldId": "f1", "value": "42", "confidence": 0.8,'; // truncated
    vi.stubGlobal('fetch', mockFetch({ choices: [{ message: { content:
      broken + '\n{"fieldId":"f1","value":"42","confidence":0.8,"reason":"ok"}' } }] }));
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, config)).suggestions;
    expect(out.get('f1')?.value).toBe('42');
  });

  it('drops hallucinated field ids', async () => {
    vi.stubGlobal('fetch', mockFetch({
      choices: [{ message: { content: JSON.stringify({ suggestions: [
        { fieldId: 'f1', value: 'x', confidence: 0.9 },
        { fieldId: 'made-up', value: 'evil', confidence: 0.99 },
      ] }) } }],
    }));
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, config)).suggestions;
    expect(out.has('f1')).toBe(true);
    expect(out.has('made-up')).toBe(false);
  });

  it('strips markdown fences around the JSON', async () => {
    vi.stubGlobal('fetch', mockFetch({
      choices: [{ message: { content: '```json\n{"suggestions":[{"fieldId":"f1","value":"Yes","confidence":0.8}]}\n```' } }],
    }));
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, config)).suggestions;
    expect(out.get('f1')?.value).toBe('Yes');
  });

  it('retries without response_format on HTTP 400', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('bad', { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] })),
      );
    vi.stubGlobal('fetch', f);
    await suggestWithLlm([field({ id: 'f1' })], profile, config);
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[1][1].body).response_format).toBeUndefined();
  });

  it('degrades gracefully on HTTP errors after retry (returns empty, no throw)', async () => {
    RETRY_BACKOFF_MS.value = 1; // don't actually sleep in tests
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const { suggestions, errors } = await suggestWithLlm([field({ id: 'f1' })], profile, config);
    expect(suggestions.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/HTTP 500/);
  });

  it('paces batches sequentially with a gap (free-tier TPM friendly)', async () => {
    RETRY_BACKOFF_MS.value = 1;
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] })),
    );
    vi.stubGlobal('fetch', f);
    const sleeps: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      return origSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      await suggestWithLlm([field({ id: 'f1' }), field({ id: 'f2', name: 'b' }), field({ id: 'f3', name: 'c' }), field({ id: 'f4', name: 'd' })], profile, config);
    } finally {
      vi.unstubAllGlobals();
      RETRY_BACKOFF_MS.value = 30_000;
    }
    expect(f).toHaveBeenCalledTimes(2); // 4 fields / batch size 3
    expect(sleeps.filter((ms) => ms === BATCH_GAP_MS)).toHaveLength(1); // one gap before batch 2
  });

  it('returns empty without any network call when unconfigured', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, { baseUrl: '', apiKey: '', model: '' })).suggestions;
    expect(out.size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
});
