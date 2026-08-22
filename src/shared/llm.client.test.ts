import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestWithLlm } from './llm';
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
    const out = await suggestWithLlm([field({ id: 'f1', label: 'Years of experience' })], profile, config);
    expect(out.get('f1')?.value).toBe('5');
    expect(out.get('f1')?.source).toBe('llm');
  });

  it('rejects malformed JSON with a clear error', async () => {
    vi.stubGlobal('fetch', mockFetch({ choices: [{ message: { content: 'sorry, I cannot' } }] }));
    await expect(suggestWithLlm([field({ id: 'f1' })], profile, config)).rejects.toThrow(/malformed/);
  });

  it('drops hallucinated field ids', async () => {
    vi.stubGlobal('fetch', mockFetch({
      choices: [{ message: { content: JSON.stringify({ suggestions: [
        { fieldId: 'f1', value: 'x', confidence: 0.9 },
        { fieldId: 'made-up', value: 'evil', confidence: 0.99 },
      ] }) } }],
    }));
    const out = await suggestWithLlm([field({ id: 'f1' })], profile, config);
    expect(out.has('f1')).toBe(true);
    expect(out.has('made-up')).toBe(false);
  });

  it('strips markdown fences around the JSON', async () => {
    vi.stubGlobal('fetch', mockFetch({
      choices: [{ message: { content: '```json\n{"suggestions":[{"fieldId":"f1","value":"Yes","confidence":0.8}]}\n```' } }],
    }));
    const out = await suggestWithLlm([field({ id: 'f1' })], profile, config);
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

  it('throws on HTTP errors after retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(suggestWithLlm([field({ id: 'f1' })], profile, config)).rejects.toThrow(/HTTP 500/);
  });

  it('returns empty without any network call when unconfigured', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const out = await suggestWithLlm([field({ id: 'f1' })], profile, { baseUrl: '', apiKey: '', model: '' });
    expect(out.size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
});
