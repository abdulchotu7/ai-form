import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { PROVIDERS, providerById, mergeModels, resolveLlmConfig, extractModelIds } from '../../shared/providers';
import { loadLiveModels, saveLiveModels } from '../api';

interface Props {
  onLoad: () => Promise<Settings>;
  onSave: (s: Settings) => Promise<void>;
}

export function SettingsView({ onLoad, onSave }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [liveByProvider, setLiveByProvider] = useState<Record<string, string[]>>({});
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const settings = await onLoad();
      setS(settings);
      try {
        const lm = await loadLiveModels();
        if (lm && typeof lm === 'object') setLiveByProvider(lm);
      } catch {
        // no chrome in tests — keep empty cache
      }
    })();
  }, [onLoad]);

  useEffect(() => {
    if (!s) return;
    const provider = providerById(s.providerId);
    const live = liveByProvider[provider.id] ?? [];
    const merged = mergeModels(provider.models, live);
    if (!s.model && merged.length > 0) {
      setS((prev) => (prev && !prev.model ? { ...prev, model: merged[0] } : prev));
    }
  }, [s?.providerId, s?.model, liveByProvider]);

  if (!s) return <p className="empty">Loading…</p>;

  const provider = providerById(s.providerId);
  const custom = provider.id === 'custom';
  const live = liveByProvider[provider.id] ?? [];
  const merged = mergeModels(provider.models, live);
  const showOffList = Boolean(s.model) && !merged.includes(s.model);

  const selectProvider = (id: string) => {
    const p = providerById(id);
    const targetLive = liveByProvider[id] ?? [];
    const targetMerged = mergeModels(p.models, targetLive);
    let model = s.model;
    if (!targetMerged.includes(s.model)) {
      if (p.id === 'custom') {
        model = targetLive[0] ?? s.model ?? '';
      } else {
        model = p.models[0] ?? targetLive[0] ?? '';
      }
    }
    setS({ ...s, providerId: id, model });
    setFetchMsg(null);
    setFetchError(null);
  };

  const setKey = (v: string) => {
    if (custom) {
      setS({ ...s, customApiKey: v });
    } else {
      setS({ ...s, keys: { ...s.keys, [provider.id]: v } });
    }
  };

  const save = async () => {
    await onSave(s);
  };

  const fetchModels = async () => {
    if (!s) return;
    const capturedProvider = providerById(s.providerId);
    const capturedModel = s.model;
    const cfg = resolveLlmConfig(s);
    const endpoint = cfg.baseUrl.trim();
    if (!endpoint) {
      setFetchError('Enter an endpoint first.');
      setFetchMsg(null);
      return;
    }
    setFetching(true);
    setFetchMsg(null);
    setFetchError(null);
    try {
      const url = `${endpoint.replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: unknown = await res.json();
      const deduped = extractModelIds(data);
      const nextLive = { ...liveByProvider, [capturedProvider.id]: deduped };
      setLiveByProvider(nextLive);
      void saveLiveModels(nextLive);
      const mergedAfter = mergeModels(capturedProvider.models, deduped);
      let targetModel = capturedModel;
      if (!capturedModel || !mergedAfter.includes(capturedModel)) {
        if (capturedProvider.id === 'custom') {
          targetModel = deduped[0] ?? capturedModel ?? '';
        } else {
          targetModel = capturedProvider.models[0] ?? deduped[0] ?? '';
        }
      }
      if (targetModel !== capturedModel) {
        setS((prev) => (prev ? { ...prev, model: targetModel } : prev));
      }
      if (deduped.length === 0) {
        setFetchMsg('No additional models found — curated list still available.');
      } else {
        setFetchMsg(`Found ${deduped.length} models — merged with curated list.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'network error';
      setFetchError(`Could not fetch models (${msg}) — curated models still available.`);
      // Clear live cache for this provider so picker falls back to curated
      setLiveByProvider((prev) => {
        const next = { ...prev };
        delete next[capturedProvider.id];
        return next;
      });
      try {
        const current = await loadLiveModels();
        const nextSave = { ...current };
        delete nextSave[capturedProvider.id];
        await saveLiveModels(nextSave);
      } catch {
        // swallow — storage may be unavailable in tests
      }
      // If the selected model was live-only, it is now retired → reset to default curated
      if (capturedProvider.id !== 'custom') {
        const curatedOnly = capturedProvider.models;
        if (capturedModel && !curatedOnly.includes(capturedModel)) {
          const fallback = curatedOnly[0] ?? '';
          setS((prev) => (prev && !curatedOnly.includes(prev.model) ? { ...prev, model: fallback } : prev));
        }
      }
    } finally {
      setFetching(false);
    }
  };

  const hasEndpoint = custom ? Boolean(s.customEndpoint.trim()) : Boolean(provider.endpoint);

  return (
    <div className="settings">
      <section className="card">
        <h2>AI provider</h2>
        <p className="hint">
          Pick a Provider and one of its curated Models. Keys are stored per Provider, in your browser only.
          An empty key is seeded from <code>VITE_&lt;PROVIDER&gt;_API_KEY</code> in <code>.env</code> at build time;
          anything saved here wins afterwards.
        </p>
        <label className="field">
          <span className="field-label">Provider</span>
          <select value={s.providerId} onChange={(e) => selectProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>

        {custom ? (
          <>
            <label className="field">
              <span className="field-label">Endpoint</span>
              <input
                value={s.customEndpoint}
                onChange={(e) => { setS({ ...s, customEndpoint: e.target.value }); }}
                placeholder="http://localhost:11434/v1"
              />
            </label>
            {live.length > 0 ? (
              <label className="field">
                <span className="field-label">Model</span>
                <select value={s.model} onChange={(e) => { setS({ ...s, model: e.target.value }); }}>
                  {!s.model && <option value="" disabled>Select a model…</option>}
                  {showOffList && <option value={s.model}>{s.model} (current)</option>}
                  {merged.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span className="field-label">Model</span>
                <input
                  value={s.model}
                  onChange={(e) => { setS({ ...s, model: e.target.value }); }}
                  placeholder="gpt-4o-mini · llama3.1 · mistral…"
                />
              </label>
            )}
          </>
        ) : (
          <>
            <p className="hint endpoint-hint" style={{ marginBottom: 12 }}>
              Endpoint: <code>{provider.endpoint}</code>
            </p>
            <label className="field">
              <span className="field-label">Model</span>
              <select value={s.model} onChange={(e) => { setS({ ...s, model: e.target.value }); }}>
                {!s.model && <option value="" disabled>Select a model…</option>}
                {showOffList && <option value={s.model}>{s.model} (current)</option>}
                {merged.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <div style={{ margin: '8px 0' }}>
          <button
            className="btn"
            onClick={() => void fetchModels()}
            disabled={fetching || !hasEndpoint}
          >
            {fetching ? 'Fetching models…' : 'Fetch available Models'}
          </button>
          {fetchMsg && <p className="hint" role="status" style={{ marginTop: 6 }}>{fetchMsg}</p>}
          {fetchError && <p className="hint" role="status" style={{ marginTop: 6 }}>{fetchError}</p>}
        </div>

        <label className="field">
          <span className="field-label">API key {provider.keyOptional ? '(optional for local servers)' : ''}</span>
          <input
            type="password"
            value={custom ? s.customApiKey : (s.keys[provider.id] ?? '')}
            onChange={(e) => setKey(e.target.value)}
            placeholder={provider.keyOptional ? 'optional — leave empty for local' : 'sk-…'}
          />
        </label>
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <ul className="hint-list">
          <li>Your profile never leaves this browser except to the provider's endpoint above.</li>
          <li>Only normalized field questions — never raw HTML — are sent for ambiguous fields.</li>
          <li>Sensitive fields (passwords, card numbers, government IDs…) are never filled or sent anywhere.</li>
        </ul>
      </section>

      <div className="save-bar">
        <button className="btn primary" onClick={() => void save()}>Save settings</button>
      </div>
    </div>
  );
}
