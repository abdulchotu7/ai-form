import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestWithLlm, fetchAvailableModels, BATCH_GAP_MS, RETRY_BACKOFF_MS } from './llm';
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

  it('batches by answer size: short fields share one request, textareas stay small', async () => {
    RETRY_BACKOFF_MS.value = 1;
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] })),
    );
    vi.stubGlobal('fetch', f);
    try {
      // 12 short fields → 1 request. A textarea rides along in a small batch.
      const many = Array.from({ length: 12 }, (_, i) => field({ id: `s${i}`, name: `n${i}` }));
      const ta = field({ id: 't1', type: 'textarea' as const, label: 'Why us?' });
      await suggestWithLlm([...many, ta], profile, config);
    } finally {
      RETRY_BACKOFF_MS.value = 30_000;
    }
    expect(f).toHaveBeenCalledTimes(2); // [12 shorts] + [1 textarea]
    const sent = f.mock.calls.map((c) => JSON.parse(c[1].body).messages[1].content);
    const counts = sent.map((s: string) => (JSON.parse(s).fields as unknown[]).length);
    expect(counts).toEqual([12, 1]);
  });

  it('rotates to the next model in the chain when one keeps failing', async () => {
    RETRY_BACKOFF_MS.value = 1;
    const ok = new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] }));
    const limited = () => new Response('rate limited', { status: 429 });
    const f = vi.fn()
      .mockResolvedValueOnce(limited()) // primary, attempt 1
      .mockResolvedValueOnce(limited()) // primary, attempt 2 (after backoff) → rotate
      .mockResolvedValueOnce(ok);       // spare, attempt 1 → done
    vi.stubGlobal('fetch', f);
    try {
      const cfg = { ...config, model: 'primary-model, spare-model' };
      const { errors } = await suggestWithLlm([field({ id: 'f1' })], profile, cfg);
      expect(errors).toHaveLength(0);
      const modelsUsed = f.mock.calls.map((c) => JSON.parse(c[1].body).model);
      // patient retry on primary, then rotate to spare
      expect(modelsUsed).toEqual(['primary-model', 'primary-model', 'spare-model']);
    } finally {
      RETRY_BACKOFF_MS.value = 30_000;
    }
  });

  it('paces requests on tight-TPM endpoints (Groq) but not others', async () => {
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
      const shorts = Array.from({ length: 13 }, (_, i) => field({ id: `p${i}`, name: `n${i}` }));
      await suggestWithLlm(shorts, profile, { ...config, baseUrl: 'https://api.groq.com/openai/v1' });
      expect(f).toHaveBeenCalledTimes(2); // 13 > SHORT_BATCH_SIZE
      expect(sleeps.filter((ms) => ms === BATCH_GAP_MS)).toHaveLength(1);

      f.mockClear();
      sleeps.length = 0;
      await suggestWithLlm(shorts, profile, config); // non-paced endpoint
      expect(sleeps.filter((ms) => ms === BATCH_GAP_MS)).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      RETRY_BACKOFF_MS.value = 30_000;
    }
  });

  it('reports when requests fell back to a spare model', async () => {
    RETRY_BACKOFF_MS.value = 1;
    const ok = new Response(JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] }));
    const limited = () => new Response('rate limited', { status: 429 });
    const f = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', f);
    try {
      const cfg = { ...config, model: 'primary-model, spare-model' };
      const { fallbackNotice } = await suggestWithLlm([field({ id: 'f1' })], profile, cfg);
      expect(fallbackNotice).toMatch(/spare-model/);
    } finally {
      RETRY_BACKOFF_MS.value = 30_000;
    }
  });

  it('fetchAvailableModels parses GET /models from any OpenAI-compatible endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 'm-a' }] }),
      { status: 200 },
    )));
    const list = await fetchAvailableModels('http://llm.test/v1/', 'key-123');
    expect(list).toEqual(['m-a', 'm-b']); // sorted, deduped, trailing slash handled
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://llm.test/v1/models');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer key-123' });
  });

  it('returns an empty model list on endpoint failure (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));
    expect(await fetchAvailableModels('http://llm.test/v1')).toEqual([]);
  });

  it('returns empty without any network call when unconfigured', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = (await suggestWithLlm([field({ id: 'f1' })], profile, { baseUrl: '', apiKey: '', model: '' })).suggestions;
    expect(out.size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
});
