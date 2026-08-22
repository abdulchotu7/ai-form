import type { FieldDescriptor, Profile, Suggestion } from './types';

/* ---------------- Sensitive field detection ---------------- */

const SENSITIVE_PATTERNS: RegExp[] = [
  /passwo?r?d/i,
  /\bpasswd\b/i,
  /\bpwd\b/i,
  /\bcvv?\b/i,
  /\bcvc\b/i,
  /card\s*(number|no|num)/i,
  /credit\s*card/i,
  /debit\s*card/i,
  /\bexpiry\b/i,
  /\bcvv/i,
  /bank\s*account/i,
  /account\s*number/i,
  /routing\s*number/i,
  /\biban\b/i,
  /\bsort\s*code\b/i,
  /\bssn\b/i,
  /social\s*security/i,
  /national\s*(id|insurance)/i,
  /\baadhaar\b/i,
  /\bpan\s*(number|no|card)\b/i,
  /passport/i,
  /\botp\b/i,
  /verification\s*code/i,
  /authenticat(ion|or)\s*code/i,
  /security\s*question/i,
  /2fa|two[- ]factor/i,
  /recovery\s*code/i,
  /\bgov(\.|\w*\s*)id\b/i,
  /driver'?s?\s*licen[cs]e/i,
];

export function isSensitive(field: FieldDescriptor): boolean {
  if (field.type === 'password' || field.type === 'file') return true;
  const hay = `${field.label} ${field.placeholder} ${field.name} ${field.context}`;
  return SENSITIVE_PATTERNS.some((p) => p.test(hay));
}

/* ---------------- Normalization ---------------- */

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Everything we know about a field, lowercased, for matching. */
function haystack(field: FieldDescriptor): string {
  return normalizeText(`${field.label} ${field.placeholder} ${field.name} ${field.context}`);
}

function matchesAny(hay: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(hay));
}

/** Total years of professional experience derived from experience date entries. */
export function deriveYearsOfExperience(profile: Profile): number | null {
  const years = new Set<number>();
  for (const e of profile.experience) {
    const start = parseInt(e.startDate.match(/\d{4}/)?.[0] ?? '', 10);
    const endRaw = e.endDate.trim();
    // "Present"/"Current" → count up to current year.
    const end = /present|current|now/i.test(endRaw)
      ? new Date().getFullYear()
      : parseInt(endRaw.match(/\d{4}/)?.[0] ?? '', 10);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      for (let y = start; y < end; y++) years.add(y);
    }
  }
  return years.size > 0 ? years.size : null;
}

export function deriveHighestEducation(profile: Profile): string | null {
  if (profile.education.length === 0) return null;
  const sorted = [...profile.education].sort((a, b) => (parseInt(b.endYear, 10) || 0) - (parseInt(a.endYear, 10) || 0));
  const top = sorted[0];
  const parts = [top.degree, top.field].filter(Boolean);
  return parts.length ? parts.join(' in ') : null;
}

/** Fuzzy match a form question against saved standard answers. */
function matchStandardAnswer(label: string, profile: Profile): { answer: string; question: string } | null {
  const qTokens = new Set(normalizeText(label).split(' ').filter((t) => t.length > 2));
  if (qTokens.size === 0) return null;
  let best: { score: number; answer: string; question: string } | null = null;
  for (const sa of profile.standardAnswers) {
    if (!sa.question || !sa.answer) continue;
    const tokens = normalizeText(sa.question).split(' ').filter((t) => t.length > 2);
    if (tokens.length === 0) continue;
    const overlap = tokens.filter((t) => qTokens.has(t)).length / Math.max(tokens.length, qTokens.size);
    if (!best || overlap > best.score) best = { score: overlap, answer: sa.answer, question: sa.question };
  }
  return best && best.score >= 0.5 ? { answer: best.answer, question: best.question } : null;
}

/* ---------------- Option matching (select / radio / checkbox-group) ---------------- */

export function matchOption(value: string, options: string[]): string | null {
  if (!value || options.length === 0) return null;
  const nv = normalizeText(value);
  for (const opt of options) {
    if (normalizeText(opt) === nv) return opt;
  }
  for (const opt of options) {
    const no = normalizeText(opt);
    if (no && (nv.includes(no) || no.includes(nv))) return opt;
  }
  return null;
}

/* ---------------- Alias table ---------------- */

interface AliasRule {
  patterns: RegExp[];
  /** Returns the raw profile value this rule resolves to, or null if unknown/empty. */
  resolve: (profile: Profile) => { value: string; source: Suggestion['source']; reason: string } | null;
}

const RULES: AliasRule[] = [
  {
    // Must run before generic "name" rules.
    patterns: [/first ?name/, /given ?name/, /forename/],
    resolve: (p) => val(p.personal.firstName, 'personal.firstName'),
  },
  {
    patterns: [/last ?name/, /surname/, /family ?name/],
    resolve: (p) => val(p.personal.lastName, 'personal.lastName'),
  },
  {
    patterns: [/preferred ?name/, /nickname/, /what should we call you/],
    resolve: (p) => val(p.personal.preferredName, 'personal.preferredName'),
  },
  {
    patterns: [/full ?name/, /^name$/, /your name/, /candidate name/, /applicant name/],
    resolve: (p) => {
      if (p.personal.fullName) return { value: p.personal.fullName, source: 'profile', reason: 'Full name from profile.' };
      const joined = [p.personal.firstName, p.personal.lastName].filter(Boolean).join(' ').trim();
      if (joined) return { value: joined, source: 'derived', reason: 'Joined first and last name from profile.' };
      return null;
    },
  },
  {
    patterns: [/e ?mail/, /\bemail\b/],
    resolve: (p) => val(p.contact.email, 'contact.email'),
  },
  {
    patterns: [/phone/, /mobile/, /telephone/, /\bcell\b/, /contact number/],
    resolve: (p) => val(p.contact.phone, 'contact.phone'),
  },
  {
    patterns: [/linkedin/],
    resolve: (p) => val(p.contact.linkedin, 'contact.linkedin'),
  },
  {
    patterns: [/github/],
    resolve: (p) => val(p.contact.github, 'contact.github'),
  },
  {
    patterns: [/website/, /portfolio/, /personal (site|url)/, /blog url/],
    resolve: (p) => val(p.contact.website, 'contact.website'),
  },
  {
    patterns: [/willing to relocate/, /open to relocation/, /able to relocate/, /^relocat/],
    resolve: (p) => val(p.preferences.relocate, 'preferences.relocate'),
  },
  {
    patterns: [/work (mode|arrangement|type)/, /remote or (hybrid|onsite|office)/, /preferred work/],
    resolve: (p) => val(p.preferences.workMode, 'preferences.workMode'),
  },
  {
    patterns: [/preferred location/, /location preference/, /work location/],
    resolve: (p) => val(p.preferences.locations, 'preferences.locations'),
  },
  {
    patterns: [/years? of (professional |relevant )?(experience|exp\b)/, /how many years.*experience/, /total experience/],
    resolve: (p) => {
      const years = deriveYearsOfExperience(p);
      if (years === null) return null;
      return { value: String(years), source: 'derived', reason: `Derived from ${p.experience.length} experience entr${p.experience.length === 1 ? 'y' : 'ies'} in your profile.` };
    },
  },
  {
    patterns: [/highest (level of )?(education|degree|qualification)/, /level of education/, /educational (background|qualification)/],
    resolve: (p) => {
      const edu = deriveHighestEducation(p);
      if (!edu) return null;
      return { value: edu, source: 'derived', reason: 'Highest education entry in your profile.' };
    },
  },
  {
    patterns: [/notice period/, /\bnotice\b/],
    resolve: (p) => val(p.jobSearch.noticePeriod, 'jobSearch.noticePeriod'),
  },
  {
    // Must run before generic "expected compensation" ("current expected" is rare, order safe).
    patterns: [/current (compensation|salary|ctc)/, /present (compensation|salary|ctc)/],
    resolve: (p) => val(p.jobSearch.currentCompensation, 'jobSearch.currentCompensation'),
  },
  {
    patterns: [
      /expected (compensation|salary|ctc|pay)/,
      /(salary|compensation) expectation/,
      /desired (salary|pay|compensation)/,
    ],
    resolve: (p) => val(p.jobSearch.expectedCompensation, 'jobSearch.expectedCompensation'),
  },
  {
    patterns: [
      /work authorization/,
      /authorized to work/,
      /legally authorized/,
      /right to work/,
      /visa (status|type|sponsorship)/,
      /sponsorship (required|required\?|needed)/,
    ],
    resolve: (p) => val(p.jobSearch.workAuthorization, 'jobSearch.workAuthorization'),
  },
  {
    patterns: [/skills?/, /tech(nical)? stack/, /technologies/, /competencies/],
    resolve: (p) => (p.skills.length ? { value: p.skills.join(', '), source: 'profile', reason: 'Skills list from profile.' } : null),
  },
];

function val(v: string, path: string): { value: string; source: Suggestion['source']; reason: string } | null {
  if (!v.trim()) return null;
  return { value: v.trim(), source: 'profile', reason: `Matched from profile (${path}).` };
}

/* ---------------- Main deterministic matcher ---------------- */

/**
 * Resolve a field against the profile without any LLM call.
 * Returns null when nothing matches confidently — caller falls back to LLM.
 */
export function deterministicMatch(field: FieldDescriptor, profile: Profile): Suggestion | null {
  if (isSensitive(field)) return null;
  const hay = haystack(field);

  for (const rule of RULES) {
    if (!matchesAny(hay, rule.patterns)) continue;
    const r = rule.resolve(profile);
    if (!r) return null; // matched the concept but no data → don't try other rules
    const finalValue =
      field.options.length > 0 ? matchOption(r.value, field.options) : r.value;
    if (!finalValue) return null;
    return {
      fieldId: field.id,
      value: finalValue,
      confidence: r.source === 'derived' ? 0.75 : 0.98,
      source: r.source,
      reason: r.reason,
    };
  }

  // Standard answers fallback (covers arbitrary saved questions).
  const labelForFuzzy = field.label || field.context;
  const sa = labelForFuzzy ? matchStandardAnswer(labelForFuzzy, profile) : null;
  if (sa) {
    const finalValue = field.options.length > 0 ? matchOption(sa.answer, field.options) : sa.answer;
    if (finalValue) {
      return {
        fieldId: field.id,
        value: finalValue,
        confidence: 0.85,
        source: 'profile',
        reason: `Saved answer for "${sa.question}".`,
      };
    }
  }

  return null;
}
