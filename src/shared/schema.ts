import { z } from 'zod';
import type { Profile } from './types';

const str = z.string().trim();

export const EducationSchema = z.object({
  institution: str.default(''),
  degree: str.default(''),
  field: str.default(''),
  startYear: str.default(''),
  endYear: str.default(''),
});

export const ExperienceSchema = z.object({
  company: str.default(''),
  title: str.default(''),
  startDate: str.default(''),
  endDate: str.default(''),
  description: str.default(''),
  technologies: str.default(''),
});

export const StandardAnswerSchema = z.object({
  question: str.default(''),
  answer: str.default(''),
});

export const JobSearchSchema = z.object({
  noticePeriod: str.default(''), // e.g. "30 days" / "Immediate"
  currentCompensation: str.default(''),
  expectedCompensation: str.default(''),
  workAuthorization: str.default(''), // e.g. "Indian citizen — no sponsorship needed"
});

export const ProfileSchema = z.object({
  personal: z
    .object({
      firstName: str.default(''),
      lastName: str.default(''),
      fullName: str.default(''),
      preferredName: str.default(''),
      gender: str.default(''),
      country: str.default(''),
      address: str.default(''),
      pincode: str.default(''),
    })
    .default({}),
  contact: z
    .object({
      email: str.default(''),
      phone: str.default(''),
      linkedin: str.default(''),
      github: str.default(''),
      website: str.default(''),
    })
    .default({}),
  education: z.array(EducationSchema).default([]),
  experience: z.array(ExperienceSchema).default([]),
  skills: z.array(str).default([]),
  preferences: z
    .object({
      relocate: str.default(''), // e.g. "Yes" / "No"
      workMode: str.default(''), // e.g. "Remote" / "Hybrid" / "On-site"
      locations: str.default(''),
    })
    .default({}),
  standardAnswers: z.array(StandardAnswerSchema).default([]),
  jobSearch: JobSearchSchema.default({}),
  // Free-text source material the LLM mines for composed answers.
  documents: z
    .object({
      resume: str.default(''),
      portfolio: str.default(''),
    })
    .default({}),
});

export const emptyProfile = (): Profile => ProfileSchema.parse({});

export const SettingsSchema = z.object({
  // Selected Provider id from the PROVIDERS registry, plus a single Model.
  // Defaults target NVIDIA's OpenAI-compatible endpoint.
  providerId: str.default('nvidia'),
  model: str.default('openai/gpt-oss-20b'),
  // API key per curated Provider id. Empty until the user saves one or it's
  // seeded from VITE_<PROVIDER>_API_KEY (build-time env, seed-if-empty only).
  keys: z.record(z.string(), str).default({}),
  // The Custom Provider keeps its own arbitrary Endpoint/Model/Key so
  // self-hosted OpenAI-compatible servers (vLLM, SGLang, LM Studio…) work.
  customEndpoint: str.default(''),
  customApiKey: str.default(''),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const emptySettings = (): Settings => SettingsSchema.parse({});

/* ---------- LLM response validation ---------- */

export const LlmSuggestionSchema = z.object({
  fieldId: z.string(),
  value: z.union([z.string(), z.null()]).optional(),
  confidence: z.coerce.number().min(0).max(1).catch(0),
  reason: z.string().optional(),
});

export const LlmResponseSchema = z.object({
  suggestions: z.array(LlmSuggestionSchema),
});
