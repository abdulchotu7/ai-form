// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { suggestWithLlm } from './llm';
import type { FieldDescriptor, Profile } from './types';
import { emptyProfile } from './schema';

/**
 * Live test using the REAL documents in context/ (resume + portfolio).
 * Skips when those files or the API key are absent.
 * Run: npx vitest run context.live
 */
const key = existsSync('.env')
  ? readFileSync('.env', 'utf8').match(/VITE_NVIDIA_API_KEY=(.+)/)?.[1]?.trim()
  : undefined;
const resume = existsSync('context/resume-software.txt') ? readFileSync('context/resume-software.txt', 'utf8') : '';
const portfolio = existsSync('context/portfolio-full.txt') ? readFileSync('context/portfolio-full.txt', 'utf8') : '';

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: 'f0', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '', ...partial };
}

describe.skipIf(!key || !resume)('live context building from real documents', () => {
  const config = {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: key!,
    model: 'openai/gpt-oss-20b', // shipped default in SettingsSchema
  };

  const profile: Profile = emptyProfile();
  profile.documents.resume = resume;
  profile.documents.portfolio = portfolio;

  it('composes a professional summary grounded in the actual resume', { timeout: 90_000 }, async () => {
    const out = (await suggestWithLlm([field({ id: 'f1', label: 'Tell us about your professional experience.' })], profile, config)).suggestions;
    const s = out.get('f1');
    console.log('  [summary]', s?.value);
    expect(s?.value).toBeTruthy();
    expect(s!.value).toMatch(/Consultadd|AWS|voice/i); // facts only present in the resume
  });

  it('answers years of experience from resume dates', { timeout: 90_000 }, async () => {
    const out = (await suggestWithLlm([field({ id: 'f2', label: 'How many years of professional experience do you have?' })], profile, config)).suggestions;
    console.log('  [years]', out.get('f2')?.value, '—', out.get('f2')?.reason);
    expect(out.get('f2')?.value).toBeTruthy();
  });

  it('describes projects from the portfolio', { timeout: 90_000 }, async () => {
    const { suggestions: out } = await suggestWithLlm(
      [field({ id: 'f3', label: 'Describe a project you are most proud of.' })],
      profile,
      config,
    );
    console.log('  [project]', out.get('f3')?.value?.slice(0, 300));
    expect(out.get('f3')?.value).toBeTruthy();
  });
});
