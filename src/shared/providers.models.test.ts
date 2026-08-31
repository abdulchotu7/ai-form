import { describe, expect, it } from 'vitest';
import { mergeModels } from './providers';

describe('mergeModels', () => {
  it('unions curated and live, deduped and sorted', () => {
    expect(mergeModels(['b', 'a'], ['c', 'a'])).toEqual(['a', 'b', 'c']);
  });

  it('handles empty curated (custom provider)', () => {
    expect(mergeModels([], ['z', 'm', 'z'])).toEqual(['m', 'z']);
  });

  it('handles empty live (fetch failed or no fetch)', () => {
    expect(mergeModels(['gpt-4o', 'gpt-4o-mini'], [])).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('handles both empty', () => {
    expect(mergeModels([], [])).toEqual([]);
  });

  it('sorts lexicographically', () => {
    expect(mergeModels(['llama3.1', 'gemma2'], ['qwen2.5', 'llama3.1'])).toEqual([
      'gemma2',
      'llama3.1',
      'qwen2.5',
    ]);
  });
});
