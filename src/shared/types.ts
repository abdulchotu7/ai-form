import type { z } from 'zod';
import type { LlmResponseSchema, ProfileSchema, SettingsSchema } from './schema';

export type Profile = z.infer<typeof ProfileSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type LlmParsedResponse = z.infer<typeof LlmResponseSchema>;

/** Field types we understand, normalized from the DOM. */
export type FieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'radio' // radio group
  | 'checkbox' // single checkbox
  | 'checkbox-group'
  | 'file'
  | 'password'
  | 'other';

/**
 * Normalized field descriptor sent to the matcher / LLM.
 * `id` is an internal session id — never a CSS selector.
 */
export interface FieldDescriptor {
  id: string;
  type: FieldType;
  label: string;
  placeholder: string;
  required: boolean;
  options: string[];
  /** Extra surrounding text (fieldset legend, nearby heading). */
  context: string;
  name: string;
}

export type ConfidenceBand = 'high' | 'medium' | 'low';

export interface Suggestion {
  fieldId: string;
  value: string | null;
  confidence: number; // 0..1
  source: 'profile' | 'llm' | 'derived' | 'unresolved';
  reason: string;
}

export type FillStatus = 'filled' | 'not-found' | 'skipped-sensitive' | 'failed' | 'empty' | 'manual';

export interface FillResult {
  fieldId: string;
  status: FillStatus;
  /** Short human-readable reason for failures, shown in the review list. */
  detail?: string;
}

/** Messages side panel -> content script. */
export type ContentRequest =
  | { type: 'AF_DETECT' }
  | { type: 'AF_FILL'; values: { fieldId: string; value: string }[]; verifyOnly?: boolean }
  /** Focus (and optionally clear) a field ahead of a CDP trusted-input refill. */
  | { type: 'AF_FOCUS'; fieldId: string; clear?: boolean };

export interface PageContext {
  title: string;
  description: string;
}

export interface DetectResponse {
  fields: FieldDescriptor[];
  /** Monotonic counter incremented when the page DOM mutates after last scan. */
  domVersion: number;
  /** Page title + meta description — grounds narrative answers in the actual job posting. */
  pageContext: PageContext;
}

export function confidenceBand(c: number): ConfidenceBand {
  if (c >= 0.9) return 'high';
  if (c >= 0.7) return 'medium';
  return 'low';
}
