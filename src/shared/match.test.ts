import { describe, expect, it } from 'vitest';
import type { FieldDescriptor, Profile } from './types';
import { deterministicMatch, deriveYearsOfExperience, isSensitive, matchOption } from './match';
import { emptyProfile } from './schema';

function field(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    id: 'f0',
    type: 'text',
    label: '',
    placeholder: '',
    required: false,
    options: [],
    context: '',
    name: '',
    ...partial,
  };
}

const profile = (patch?: (p: Profile) => void): Profile => {
  const p = emptyProfile();
  p.personal.firstName = 'Abdul';
  p.personal.lastName = 'Rahim';
  p.personal.fullName = 'Abdul Rahim';
  p.contact.email = 'abdul@example.com';
  p.contact.phone = '+91 98765 43210';
  p.contact.linkedin = 'linkedin.com/in/abdul';
  p.contact.github = 'github.com/abdul';
  patch?.(p);
  return p;
};

describe('deterministic matching', () => {
  const cases: [string, string][] = [
    ['First Name', 'Abdul'],
    ['Given Name', 'Abdul'],
    ['Candidate first name', 'Abdul'],
    ['Your first name', 'Abdul'],
    ['Last Name', 'Rahim'],
    ['Surname', 'Rahim'],
    ['Family name', 'Rahim'],
    ['Full name', 'Abdul Rahim'],
    ['Name', 'Abdul Rahim'],
    ['Email Address', 'abdul@example.com'],
    ['E-mail', 'abdul@example.com'],
    ['Mobile Number', '+91 98765 43210'],
    ['Telephone', '+91 98765 43210'],
    ['Phone', '+91 98765 43210'],
    ['LinkedIn URL', 'linkedin.com/in/abdul'],
    ['GitHub Profile', 'github.com/abdul'],
    ['Preferred name', ''], // not set → unresolved handled by null return
  ];

  for (const [label, expected] of cases) {
    it(`matches "${label}"`, () => {
      const s = deterministicMatch(field({ label }), profile());
      if (expected === '') {
        // preferredName empty → rule matched concept but no data → null (LLM fallback)
        expect(s).toBeNull();
      } else {
        expect(s?.value).toBe(expected);
        expect(s?.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });
  }

  it('prefers first-name over generic name rules', () => {
    expect(deterministicMatch(field({ label: 'First Name' }), profile())?.value).toBe('Abdul');
  });

  it('joins names for Full name when fullName is blank', () => {
    const s = deterministicMatch(field({ label: 'Full name' }), profile((p) => void (p.personal.fullName = '')));
    expect(s?.value).toBe('Abdul Rahim');
    expect(s?.source).toBe('derived');
  });

  it('matches via placeholder when label is missing', () => {
    const s = deterministicMatch(field({ placeholder: 'Enter your email' }), profile());
    expect(s?.value).toBe('abdul@example.com');
  });

  it('matches skills list', () => {
    const s = deterministicMatch(field({ label: 'Skills' }), profile((p) => void (p.skills = ['Python', 'SQL'])));
    expect(s?.value).toBe('Python, SQL');
  });
});

describe('job search details', () => {
  const prof = profile((p) => {
    p.jobSearch.noticePeriod = '30 days';
    p.jobSearch.currentCompensation = '12 LPA';
    p.jobSearch.expectedCompensation = '18 LPA';
    p.jobSearch.workAuthorization = 'Indian citizen, no sponsorship needed';
  });
  it.each([
    ['Notice Period', '30 days'],
    ['Current CTC', '12 LPA'],
    ['What are your salary expectations?', '18 LPA'],
    ['Are you legally authorized to work in this country?', 'Indian citizen, no sponsorship needed'],
    ['Will you now or in the future require visa sponsorship?', 'Indian citizen, no sponsorship needed'],
  ])('matches "%s"', (label, expected) => {
    expect(deterministicMatch(field({ label }), prof)?.value).toBe(expected);
  });
});

describe('semantic derivations', () => {
  it('derives years of experience from date ranges', () => {
    const p = profile((p) =>
      void p.experience.push(
        { company: 'A', title: '', startDate: '2022-03', endDate: 'Present', description: '', technologies: '' },
        { company: 'B', title: '', startDate: '2020-01', endDate: '2022-02', description: '', technologies: '' },
      ),
    );
    // 2022→2026 (4) + 2020→2022 (2) = 6 distinct years
    expect(deriveYearsOfExperience(p)).toBe(new Set([2020, 2021, 2022, 2023, 2024, 2025]).size);
    const s = deterministicMatch(field({ label: 'How many years of experience do you have?' }), p);
    expect(s?.value).toBe('6');
    expect(s?.source).toBe('derived');
  });

  it('does not fabricate years of experience without dates', () => {
    const p = profile((p) =>
      void p.experience.push({ company: 'A', title: '', startDate: '', endDate: '', description: '', technologies: '' }),
    );
    expect(deterministicMatch(field({ label: 'Years of experience' }), p)).toBeNull();
  });

  it('derives highest education', () => {
    const p = profile((p) =>
      void p.education.push(
        { institution: 'X', degree: 'B.Tech', field: 'CS', startYear: '2016', endYear: '2020' },
        { institution: 'Y', degree: 'M.Sc', field: 'AI', startYear: '2020', endYear: '2022' },
      ),
    );
    const s = deterministicMatch(field({ label: 'What is your highest level of education?' }), p);
    expect(s?.value).toBe('M.Sc in AI');
  });

  it('matches saved standard answers fuzzily', () => {
    const p = profile((p) =>
      void p.standardAnswers.push({
        question: 'Why are you interested in this role?',
        answer: 'I love building developer tools.',
      }),
    );
    const s = deterministicMatch(field({ label: 'Why are you interested in this role?' }), p);
    expect(s?.value).toBe('I love building developer tools.');
  });

  it('resolves select/radio options to the exact option text', () => {
    const p = profile((pp) => void (pp.preferences.relocate = 'Yes'));
    const s = deterministicMatch(field({ label: 'Are you willing to relocate?', options: ['--Select--', 'No', 'Yes'] }), p);
    expect(s?.value).toBe('Yes');
  });
});

describe('sensitive fields', () => {
  const labels = [
    'Password', 'Confirm Password', 'Card Number', 'CVV', 'Credit card number',
    'Bank Account Number', 'SSN', 'Social Security Number', 'Passport No',
    'Aadhaar number', 'OTP', 'Verification code', 'Security Question 1',
  ];
  for (const label of labels) {
    it(`flags "${label}" as sensitive`, () => {
      expect(isSensitive(field({ label }))).toBe(true);
    });
  }
  it('never returns suggestions for sensitive fields', () => {
    expect(deterministicMatch(field({ label: 'Account Number' }), profile())).toBeNull();
  });
  it('does not flag ordinary fields', () => {
    expect(isSensitive(field({ label: 'First Name' }))).toBe(false);
  });
});

describe('option matching', () => {
  it('is case/whitespace insensitive', () => {
    expect(matchOption('remote', ['On-site', 'Hybrid', 'Remote'])).toBe('Remote');
  });
  it('returns null on no plausible match', () => {
    expect(matchOption('Quantum Physics', ['Yes', 'No'])).toBeNull();
  });
});
