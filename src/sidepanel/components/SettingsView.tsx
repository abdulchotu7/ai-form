import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { PROVIDERS, providerById } from '../../shared/providers';

interface Props {
  onLoad: () => Promise<Settings>;
  onSave: (s: Settings) => Promise<void>;
}

export function SettingsView({ onLoad, onSave }: Props) {
  const [s, setS] = useState<Settings | null>(null);

  useEffect(() => {
    void onLoad().then(setS);
  }, [onLoad]);

  if (!s) return <p className="empty">Loading…</p>;

  const provider = providerById(s.providerId);
  const custom = provider.id === 'custom';
  // Keep a saved model that isn't curated (migrated value) so it is never lost —
  // it just shows as "(current)" above the curated list.
  const offList = Boolean(s.model) && !provider.models.includes(s.model);

  const selectProvider = (id: string) => {
    const p = providerById(id);
    // Switching Provider resets Model to the new Provider's default when the
    // current Model isn't in its curated list.
    const model = p.models.includes(s.model) ? s.model : (p.models[0] ?? '');
    setS({ ...s, providerId: id, model });
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
            <label className="field">
              <span className="field-label">Model</span>
              <input
                value={s.model}
                onChange={(e) => { setS({ ...s, model: e.target.value }); }}
                placeholder="gpt-4o-mini · llama3.1 · mistral…"
              />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Endpoint</span>
              <input readOnly value={provider.endpoint} />
            </label>
            <label className="field">
              <span className="field-label">Model</span>
              <select value={s.model} onChange={(e) => { setS({ ...s, model: e.target.value }); }}>
                {offList && <option value={s.model}>{s.model} (current)</option>}
                {provider.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          </>
        )}

        <label className="field">
          <span className="field-label">API key {provider.keyOptional ? '(optional for local servers)' : ''}</span>
          <input
            type="password"
            value={custom ? s.customApiKey : (s.keys[provider.id] ?? '')}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
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
