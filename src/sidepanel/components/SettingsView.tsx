import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/schema';
import { fetchAvailableModels } from '../../shared/llm';

interface Props {
  onLoad: () => Promise<Settings>;
  onSave: (s: Settings) => Promise<void>;
}

export function SettingsView({ onLoad, onSave }: Props) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    void onLoad().then(setS);
  }, [onLoad]);

  if (!s) return <p className="empty">Loading…</p>;

  const save = async () => {
    await onSave(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const loadModels = async () => {
    if (!s.llmBaseUrl.trim()) return;
    setLoadingModels(true);
    try {
      // The saved key is used when the field is untouched (type=password keeps
      // it masked but present); otherwise whatever the user just typed.
      const key = s.llmApiKey || undefined;
      const list = await fetchAvailableModels(s.llmBaseUrl, key);
      setModels(list);
      if (list.length > 0 && !list.includes(s.llmModel.trim()) && !s.llmModel.includes(',')) {
        // Keep the current model selected even if not in list — user may know better.
      }
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="settings">
      <section className="card">
        <h2>AI endpoint</h2>
        <p className="hint">
          Defaults to NVIDIA's API (key injected from .env at build time). Any OpenAI-compatible
          endpoint works too: OpenAI, a local Ollama / vLLM / SGLang server, LM Studio…
        </p>
        <label className="field">
          <span className="field-label">Base URL</span>
          <input
            value={s.llmBaseUrl}
            onChange={(e) => { setS({ ...s, llmBaseUrl: e.target.value }); setSaved(false); }}
            placeholder="https://api.openai.com/v1  ·  http://localhost:11434/v1"
          />
        </label>
        <label className="field">
          <span className="field-label">Model</span>
          {models.length > 0 ? (
            <>
              <select
                value={models.includes(s.llmModel.trim()) || s.llmModel.includes(',') ? s.llmModel : ''}
                onChange={(e) => { setS({ ...s, llmModel: e.target.value }); setSaved(false); }}
              >
                {!models.includes(s.llmModel.trim()) && !s.llmModel.includes(',') && (
                  <option value="">— pick a model —</option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <span className="hint">{models.length} models from your endpoint.</span>
            </>
          ) : (
            <input
              value={s.llmModel}
              onChange={(e) => { setS({ ...s, llmModel: e.target.value }); setSaved(false); }}
              placeholder="gpt-4o-mini · llama3.1 · mistral…"
            />
          )}
        </label>
        <button className="btn-link" onClick={() => void loadModels()} disabled={loadingModels}>
          {loadingModels ? 'Fetching models…' : models.length > 0 ? '↻ Refresh model list' : 'Fetch available models'}
        </button>
        <label className="field">
          <span className="field-label">API key (optional for local servers)</span>
          <input
            type="password"
            value={s.llmApiKey}
            onChange={(e) => { setS({ ...s, llmApiKey: e.target.value }); setSaved(false); }}
            placeholder="sk-…"
          />
        </label>
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <ul className="hint-list">
          <li>Your profile never leaves this browser except to the endpoint above.</li>
          <li>Only normalized field questions — never raw HTML — are sent for ambiguous fields.</li>
          <li>Sensitive fields (passwords, card numbers, government IDs…) are never filled or sent anywhere.</li>
        </ul>
      </section>

      <div className="save-bar">
        <button className="btn primary" onClick={() => void save()}>Save settings</button>
        {saved && <span className="save-ok">Saved ✓</span>}
      </div>
    </div>
  );
}
