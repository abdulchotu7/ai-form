// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { suggestWithLlm } from './llm';
import type { FieldDescriptor, Profile } from './types';
import { emptyProfile } from './schema';

/**
 * Live integration test against the real NVIDIA endpoint.
 * Skipped unless VITE_NVIDIA_API_KEY is present in .env.
 * Run explicitly: npx vitest run llm.live
 */
const key = existsSync('.env')
  ? readFileSync('.env', 'utf8').match(/VITE_NVIDIA_API_KEY=(.+)/)?.[1]?.trim()
  : undefined;

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return { id: 'f0', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '', ...partial };
}

describe.skipIf(!key)('live NVIDIA endpoint (context building)', () => {
  const config = {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: key!,
    model: 'meta/llama-3.1-8b-instruct', // fast non-reasoning default
  };

  const profile: Profile = emptyProfile();
  profile.personal.firstName = 'Testy';
  profile.experience.push({
    company: 'Acme Corp',
    title: 'Software Engineer',
    startDate: '2020-07',
    endDate: 'Present',
    description: 'Built payment infrastructure serving 2M requests/day.',
    technologies: 'TypeScript, Go, PostgreSQL',
  });
  profile.education.push({ institution: 'IIT Delhi', degree: 'B.Tech', field: 'Computer Science', startYear: '2016', endYear: '2020' });
  profile.skills.push('Python', 'Go');
  profile.preferences.relocate = 'Yes';
  // NOTE: no salary info anywhere → must stay unresolved.

  it('composes a professional summary from experience facts', { timeout: 180_000 }, async () => {
    const out = await suggestWithLlm([field({ id: 'f_sum', label: 'Tell us about your professional experience.' })], profile, config);
    const s = out.get('f_sum');
    expect(s).toBeDefined();
    expect(s!.value).toBeTruthy();
    // Synthesis must be grounded: mentions the employer from context.
    expect(s!.value).toMatch(/Acme/i);
    expect(s!.confidence).toBeLessThanOrEqual(0.85); // composed answers capped
  });

  it('maps options exactly and derives relocation answer', { timeout: 180_000 }, async () => {
    const out = await suggestWithLlm(
      [field({ id: 'f_rel', label: 'Are you willing to relocate?', options: ['No', 'Yes'] })],
      profile,
      config,
    );
    expect(out.get('f_rel')?.value).toBe('Yes'); // exact option text
  });

  it('never fabricates missing information (salary)', { timeout: 180_000 }, async () => {
    const out = await suggestWithLlm([field({ id: 'f_sal', label: 'What is your expected salary?' })], profile, config);
    const s = out.get('f_sal');
    expect(s?.value ?? null).toBeNull(); // no invention
  });
});
