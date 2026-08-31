import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SettingsView } from './SettingsView';
import type { Settings } from '../../shared/types';
import { emptySettings } from '../../shared/schema';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  // cleanup chrome mock if set via stub
  const g = globalThis as unknown as { chrome?: unknown };
  if (g.chrome) delete (g as Record<string, unknown>).chrome;
});

async function renderSettings(initial: Settings) {
  let saved: Settings | null = null;
  const onLoad = async () => ({ ...initial });
  const onSave = async (s: Settings) => { saved = s; };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(SettingsView, { onLoad, onSave }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { container, getSaved: () => saved };
}

function getSelectOptions(container: Element): string[] {
  const selects = container.querySelectorAll('select');
  for (const s of Array.from(selects)) {
    const opts = Array.from(s.options).map((o) => o.value);
    if (opts.includes('openai') && opts.includes('groq')) continue;
    return opts;
  }
  return [];
}

describe('SettingsView live model discovery', () => {
  it('Fetch button exists and uses selected Provider endpoint + per-Provider key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'live-a' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const initial: Settings = {
      ...emptySettings(),
      providerId: 'groq',
      model: 'llama-3.1-8b-instant',
      keys: { groq: 'groq-secret', nvidia: 'nvidia-secret', openai: 'openai-secret' },
    };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fetch available Models'),
    );
    expect(btn).toBeTruthy();
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer groq-secret' });
  });

  it('merges live models into dropdown deduped and sorted, preserving selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'live-z' }, { id: 'live-a' }] }), { status: 200 }),
      ),
    );
    const initial: Settings = {
      ...emptySettings(),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      keys: { openai: 'k' },
    };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fetch available Models'),
    )!;
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const opts = getSelectOptions(container);
    expect(opts).toEqual([...new Set(opts)].sort((a, b) => a.localeCompare(b)));
    expect(opts).toContain('gpt-4o-mini');
    expect(opts).toContain('live-a');
    expect(opts).toContain('live-z');
    const modelSelect = Array.from(container.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'live-a'),
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe('gpt-4o-mini');
  });

  it('keeps current selection as hint when not in curated or live', async () => {
    // ADR 0002: retired model (not in curated ∪ new live) resets to Provider default curated model
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'live-new' }] }), { status: 200 })),
    );
    const initial: Settings = {
      ...emptySettings(),
      providerId: 'openai',
      model: 'my-legacy-model',
      keys: { openai: 'k' },
    };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fetch available Models'),
    )!;
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const opts = getSelectOptions(container);
    // Retired: my-legacy-model not in merged (curated ∪ live-new) → should NOT linger as (current)
    expect(opts).not.toContain('my-legacy-model');
    const modelSelect = Array.from(container.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'gpt-4o-mini'),
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe('gpt-4o-mini');
    expect(container.textContent).not.toMatch(/\(current\)/);
  });

  it('fetch failure shows non-blocking message and leaves curated models usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    const initial: Settings = {
      ...emptySettings(),
      providerId: 'openai',
      model: 'gpt-4o-mini',
      keys: { openai: 'bad-key' },
    };
    const { container } = await renderSettings(initial);
    const optsBefore = getSelectOptions(container);
    expect(optsBefore.length).toBeGreaterThan(0);
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fetch available Models'),
    )!;
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const optsAfter = getSelectOptions(container);
    expect(optsAfter).toEqual(optsBefore);
    expect(container.textContent).toMatch(/Could not fetch|Failed|curated/i);
    const modelSelect = Array.from(container.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'gpt-4o-mini'),
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe('gpt-4o-mini');
  });

  it('works for Custom Provider with user-typed endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'custom-live-1' }, { id: 'custom-live-2' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const initial: Settings = {
      ...emptySettings(),
      providerId: 'custom',
      model: 'custom-live-1',
      customEndpoint: 'http://localhost:11434/v1',
      customApiKey: 'custom-key',
    };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Fetch available Models'),
    )!;
    expect(btn).toBeTruthy();
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:11434/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer custom-key' },
    }));
    const opts = getSelectOptions(container);
    expect(opts).toContain('custom-live-1');
    expect(opts).toContain('custom-live-2');
    // Selection preserved because it is still in live
    const modelSelect = Array.from(container.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'custom-live-1'),
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe('custom-live-1');
  });
});

describe('SettingsView Live Model Cache persistence (ADR 0002)', () => {
  function mockChromeStore(initialLive: Record<string, string[]>) {
    let store: Record<string, unknown> = { liveModels: { ...initialLive } };
    const get = vi.fn().mockImplementation(async (key: string) => {
      if (key === 'liveModels') return { liveModels: store.liveModels };
      if (key === 'settings') return {};
      return { [key]: store[key] };
    });
    const set = vi.fn().mockImplementation(async (obj: Record<string, unknown>) => {
      Object.assign(store, obj);
    });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get, set } },
    } as unknown as typeof chrome;
    return { get, set, store: () => store };
  }

  it('loads Live Model Cache from storage on mount — no fetch needed', async () => {
    mockChromeStore({ openai: ['live-persisted-a', 'live-persisted-b'] });
    const initial: Settings = { ...emptySettings(), providerId: 'openai', model: 'gpt-4o-mini', keys: { openai: 'k' } };
    const { container } = await renderSettings(initial);
    const opts = getSelectOptions(container);
    expect(opts).toContain('live-persisted-a');
    expect(opts).toContain('live-persisted-b');
    expect(opts).toContain('gpt-4o-mini');
  });

  it('keeps cache per Provider — switching providers shows correct union', async () => {
    mockChromeStore({ groq: ['groq-live'], nvidia: ['nvidia-live'] });
    const initial: Settings = { ...emptySettings(), providerId: 'groq', model: 'groq-live', keys: { groq: 'k', nvidia: 'k2' } };
    const { container } = await renderSettings(initial);
    let opts = getSelectOptions(container);
    expect(opts).toContain('groq-live');
    expect(opts).not.toContain('nvidia-live');

    const providerSelect = container.querySelectorAll('select')[0] as HTMLSelectElement;
    await act(async () => {
      providerSelect.value = 'nvidia';
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    opts = getSelectOptions(container);
    expect(opts).toContain('nvidia-live');
    expect(opts).not.toContain('groq-live');
  });

  it('persists fetched live models to chrome.storage and clears on failure', async () => {
    const { set } = mockChromeStore({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'fresh-live' }] }), { status: 200 })));
    const initial: Settings = { ...emptySettings(), providerId: 'openai', model: 'gpt-4o-mini', keys: { openai: 'k' } };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Fetch available Models'))!;
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ liveModels: expect.objectContaining({ openai: ['fresh-live'] }) }));

    // Now failure should clear that slot
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await act(async () => {
      (btn as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // Last set should have cleared openai slot
    const lastCall = set.mock.calls[set.mock.calls.length - 1][0] as { liveModels: Record<string, string[]> };
    expect(lastCall.liveModels.openai).toBeUndefined();
    expect(container.textContent).toMatch(/Could not fetch models/);
  });

  it('Fetch button is disabled when Custom endpoint is empty', async () => {
    const initial: Settings = { ...emptySettings(), providerId: 'custom', model: '', customEndpoint: '', customApiKey: '' };
    const { container } = await renderSettings(initial);
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Fetch available Models')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('does not auto-fetch on load', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mockChromeStore({ openai: ['cached-live'] });
    const initial: Settings = { ...emptySettings(), providerId: 'openai', model: 'cached-live', keys: { openai: 'k' } };
    await renderSettings(initial);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
