import { useCallback, useEffect, useState } from 'react';
import type { DetectResponse, FieldDescriptor, FillResult, Profile, Suggestion } from '../shared/types';
import { isSensitive, deterministicMatch, plausible } from '../shared/match';
import { suggestWithLlm } from '../shared/llm';
import { resolveLlmConfig } from '../shared/providers';
import { detectFields, fillFields, loadProfile, loadSettings, saveProfile, saveSettings, currentPageInfo } from './api';
import { ProfileForm } from './components/ProfileForm';
import { AnalysisView } from './components/AnalysisView';
import { SettingsView } from './components/SettingsView';

export interface AnalyzedField {
  field: FieldDescriptor;
  suggestion: Suggestion;
  sensitive: boolean;
  included: boolean;
  fillStatus?: FillResult['status'];
  fillDetail?: string;
}

type Phase = 'idle' | 'analyzing' | 'ready' | 'filling' | 'filled';

interface Analysis {
  fields: AnalyzedField[];
  domVersion: number;
}

export default function App() {
  const [tab, setTab] = useState<'form' | 'profile' | 'settings'>('form');
  const [host, setHost] = useState('');
  const [analyzable, setAnalyzable] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stageLabel, setStageLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [llmConfigured, setLlmConfigured] = useState(false);

  useEffect(() => {
    void (async () => {
      setProfile(await loadProfile());
      const s = await loadSettings();
      const cfg = resolveLlmConfig(s);
      setLlmConfigured(Boolean(cfg.baseUrl && cfg.model));
    })();
    void currentPageInfo().then(({ host, isAnalyzable }) => {
      setHost(host);
      setAnalyzable(isAnalyzable);
    });
  }, []);

  const handleSaveProfile = useCallback(async (p: Profile) => {
    await saveProfile(p);
    setProfile(p);
  }, []);

  const analyze = useCallback(async () => {
    if (!profile) return;
    setError(null);
    setNotice(null);
    setPhase('analyzing');
    try {
      setStageLabel('Scanning page…');
      let detected: DetectResponse;
      try {
        detected = await detectFields();
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'Could not reach the page. Try refreshing it.');
      }
      if (detected.fields.length === 0) {
        setAnalysis({ fields: [], domVersion: detected.domVersion });
        setPhase('ready');
        return;
      }

      setStageLabel(`Preparing ${detected.fields.length} fields…`);
      const analyzed: AnalyzedField[] = [];
      const forLlm: FieldDescriptor[] = [];
      const hints = new Map<string, string>();

      for (const field of detected.fields) {
        const sensitive = isSensitive(field);
        // Scope: the extension fills TEXT fields only. Selects, radios,
        // checkboxes and file uploads are manual — the user does those.
        if (!sensitive && (field.type === 'text' || field.type === 'textarea' || field.type === 'email' || field.type === 'tel' || field.type === 'number' || field.type === 'date')) {
          // Deterministic profile match is a HINT for the LLM to verify or
          // correct, not a final answer.
          const det = deterministicMatch(field, profile);
          if (det?.value) hints.set(field.id, det.value);
          analyzed.push({ field, sensitive, included: false, suggestion: { fieldId: field.id, value: null, confidence: 0, source: 'unresolved', reason: '' } });
          forLlm.push(field);
          continue;
        }
        analyzed.push({
          field,
          sensitive,
          included: false,
          suggestion: {
            fieldId: field.id,
            value: null,
            confidence: 0,
            source: 'unresolved',
            reason: sensitive
              ? 'Sensitive field — manual entry required.'
              : `${field.type} field — fill it manually (dropdowns, checkboxes and uploads stay yours).`,
          },
        });
      }

      if (forLlm.length > 0) {
        const settings = await loadSettings();
        const cfg = resolveLlmConfig(settings);
        if (cfg.baseUrl && cfg.model) {
          setStageLabel(`Asking the AI about ${forLlm.length} question${forLlm.length > 1 ? 's' : ''}…`);
          try {
            const llmResult = await suggestWithLlm(
              forLlm,
              profile,
              cfg,
              detected.pageContext,
              hints,
            );
            for (const a of analyzed) {
              const s = llmResult.suggestions.get(a.field.id);
              // The LLM had the final say (it saw the deterministic hint and
              // confirmed/corrected/rejected it). Implausible answers (city in
              // a pincode field etc.) are still dropped, not filled.
              if (s && !a.sensitive && a.suggestion.source === 'unresolved') {
                if (s.value !== null && !plausible(a.field, s.value)) continue;
                a.suggestion = s;
                a.included = s.value !== null && s.confidence >= 0.7;
              }
            }
            if (llmResult.errors.length > 0) {
              setNotice(
                llmResult.suggestions.size === 0
                  ? `AI suggestions failed — check your endpoint/model in Settings. (${llmResult.errors[0]})`
                  : `Some AI answers failed and were left blank. (${llmResult.errors[0]})`,
              );
            } else if (llmResult.fallbackNotice) {
              setNotice(llmResult.fallbackNotice);
            }
          } catch (e) {
            setNotice(e instanceof Error ? e.message : 'AI suggestions failed.');
          }
        } else if (!cfg.baseUrl) {
          setNotice('AI suggestions are off — add an LLM endpoint in Settings to answer text questions.');
        } else {
          setNotice('AI suggestions are off — select a Model in Settings to answer text questions.');
        }
      }

      // Anything still empty → explicit unresolved marker.
      for (const a of analyzed) {
        if (!a.suggestion.reason && a.suggestion.value === null) {
          a.suggestion = { ...a.suggestion, source: 'unresolved', reason: 'No information available.' };
          a.included = false;
        }
      }

      setAnalysis({ fields: analyzed, domVersion: detected.domVersion });
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    }
  }, [profile]);

  const updateField = useCallback((fieldId: string, patch: Partial<AnalyzedField>) => {
    setAnalysis((prev) =>
      prev
        ? { ...prev, fields: prev.fields.map((f) => (f.field.id === fieldId ? { ...f, ...patch } : f)) }
        : prev,
    );
  }, []);

  const fillApproved = useCallback(async () => {
    if (!analysis) return;
    setError(null);
    setPhase('filling');
    try {
      const values = analysis.fields
        .filter((f) => f.included && f.suggestion.value)
        .map((f) => ({ fieldId: f.field.id, value: f.suggestion.value!, kind: f.field.type }));
      const { results } = await fillFields(values);
      const byId = new Map(results.map((r) => [r.fieldId, r]));
      setAnalysis((prev) =>
        prev
          ? {
              ...prev,
              fields: prev.fields.map((f) => ({
                ...f,
                fillStatus: byId.get(f.field.id)?.status,
                fillDetail: byId.get(f.field.id)?.detail,
              })),
            }
          : prev,
      );
      setPhase('filled');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  }, [analysis]);
  const fillOne = useCallback(
    async (fieldId: string, value: string, kind: string) => {
      const { results } = await fillFields([{ fieldId, value, kind }]);
      const r = results[0];
      if (!r) return;
      setAnalysis((prev) =>
        prev
          ? {
              ...prev,
              fields: prev.fields.map((f) =>
                f.field.id === fieldId
                  ? { ...f, fillStatus: r.status, fillDetail: r.detail }
                  : f,
              ),
            }
          : prev,
      );
    },
    [],
  );

  const stale = phase === 'filled' && analysis !== null;

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">AI Form Assistant</div>
        <div className="header-domain">{host || 'no page'}</div>
      </header>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'active' : ''} onClick={() => setTab('form')}>Form</button>
        <button role="tab" aria-selected={tab === 'profile'} className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>Profile</button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
      </nav>

      <main className="main">
        {tab === 'form' && (
          <AnalysisView
            analyzable={analyzable}
            phase={phase}
            stageLabel={stageLabel}
            error={error}
            notice={notice}
            llmConfigured={llmConfigured}
            analysis={analysis}
            onAnalyze={() => void analyze()}
            onFill={() => void fillApproved()}
            onFillField={(fieldId, value, kind) => void fillOne(fieldId, value, kind)}
            onUpdateField={updateField}
            onGoToSettings={() => setTab('settings')}
            hasProfile={Boolean(profile)}
          />
        )}
        {tab === 'profile' && profile && (
          <ProfileForm initial={profile} onSave={(p) => void handleSaveProfile(p)} />
        )}
        {tab === 'settings' && (
          <SettingsView
            onLoad={loadSettings}
            onSave={async (s) => {
              await saveSettings(s);
              const cfg = resolveLlmConfig(s);
              setLlmConfigured(Boolean(cfg.baseUrl && cfg.model));
              setNotice(null);
            }}
          />
        )}
      </main>

      {stale && (
        <footer className="footer-note">Filled. Review the page and submit manually — the extension never submits.</footer>
      )}
    </div>
  );
}
