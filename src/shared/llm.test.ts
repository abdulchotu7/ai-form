import { describe, expect, it } from 'vitest';
import { buildUserPrompt, extractJson } from './llm';
import { LlmResponseSchema } from './schema';
import type { FieldDescriptor, Profile } from './types';
import { emptyProfile } from './schema';

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: 'f0', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '', ...partial };
}

describe('LLM response validation', () => {
  it('accepts well-formed suggestions', () => {
    const r = LlmResponseSchema.safeParse({
      suggestions: [{ fieldId: 'f1', value: '3', confidence: 0.95, reason: 'from experience' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects non-object garbage', () => {
    expect(LlmResponseSchema.safeParse('hello world').success).toBe(false);
    expect(LlmResponseSchema.safeParse(42).success).toBe(false);
    expect(LlmResponseSchema.safeParse({}).success).toBe(false);
  });

  it('rejects suggestions without a fieldId', () => {
    expect(LlmResponseSchema.safeParse({ suggestions: [{ value: 'x' }] }).success).toBe(false);
  });

  it('coerces out-of-range confidence instead of trusting it', () => {
    const r = LlmResponseSchema.parse({ suggestions: [{ fieldId: 'f1', value: 'x', confidence: 7 }] });
    expect(r.suggestions[0].confidence).toBe(0); // .catch(0) on invalid range
  });

  it('allows null values (unresolved)', () => {
    const r = LlmResponseSchema.parse({ suggestions: [{ fieldId: 'f1', value: null, confidence: 0 }] });
    expect(r.suggestions[0].value).toBeNull();
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('throws on prose', () => {
    expect(() => extractJson('I cannot answer that.')).toThrow();
  });
});

describe('prompt building (privacy)', () => {
  it('sends normalized fields only — no raw HTML anywhere', () => {
    const profile: Profile = emptyProfile();
    profile.personal.firstName = 'Abdul';
    const prompt = buildUserPrompt([field({ id: 'f9', label: 'Tell us about yourself' })], profile);
    expect(prompt).toContain('"fieldId": "f9"');
    expect(prompt).not.toContain('<div');
    expect(prompt).not.toContain('<input');
  });

  it('strips sensitive fields from the prompt entirely', () => {
    const prompt = buildUserPrompt([field({ id: 'f1', label: 'Password' }), field({ id: 'f2', label: 'Favorite color' })], emptyProfile());
    expect(prompt).not.toContain('Password');
    expect(prompt).toContain('Favorite color');
  });

  it('includes options so the model can pick exact matches', () => {
    const prompt = buildUserPrompt([field({ label: 'Work mode', options: ['Remote', 'Hybrid'] })], emptyProfile());
    expect(prompt).toContain('Remote');
  });

  it('includes resume and portfolio documents in the context', () => {
    const p: Profile = emptyProfile();
    p.documents.resume = 'Software Engineer at Consultadd, built AWS voice platform processing 125K+ calls/day.';
    p.documents.portfolio = 'Rebuilt NVIDIA streaming ASR as stateful O(n) engine on Apple Silicon.';
    const prompt = buildUserPrompt([field({ id: 'f1', label: 'Tell us about yourself' })], p);
    expect(prompt).toContain('125K+ calls/day');
    expect(prompt).toContain('NVIDIA streaming ASR');
  });

  it('caps oversized documents to keep prompts fast', () => {
    const p: Profile = emptyProfile();
    p.documents.resume = 'x'.repeat(50_000);
    const prompt = buildUserPrompt([field({ id: 'f1' })], p);
    // 8k cap + JSON overhead — well under the old 50k blob.
    expect(prompt.length).toBeLessThan(20_000);
  });
});
