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
    expect(opts).toContain('my-legacy-model');
    const modelSelect = Array.from(container.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'my-legacy-model'),
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe('my-legacy-model');
    expect(modelSelect.options[modelSelect.selectedIndex].textContent).toMatch(/\(current\)/);
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
      model: 'my-local-model',
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
    expect(opts).toContain('my-local-model');
  });
});
