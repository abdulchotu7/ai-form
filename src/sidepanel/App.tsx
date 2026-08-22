import { useCallback, useEffect, useState } from 'react';
import type { DetectResponse, FieldDescriptor, FillResult, Profile, StoredFile, Suggestion } from '../shared/types';
import { isSensitive, deterministicMatch } from '../shared/match';
import { suggestWithLlm } from '../shared/llm';
import { detectFields, fillFields, loadProfile, loadResumeFile, loadSettings, saveProfile, saveResumeFile, saveSettings, currentPageInfo } from './api';
import { ProfileForm } from './components/ProfileForm';
import { AnalysisView } from './components/AnalysisView';
import { SettingsView } from './components/SettingsView';

export interface AnalyzedField {
  field: FieldDescriptor;
  suggestion: Suggestion;
  sensitive: boolean;
  included: boolean;
  fillStatus?: FillResult['status'];
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
  const [resumeFile, setResumeFile] = useState<StoredFile | null>(null);

  useEffect(() => {
    void (async () => {
      setProfile(await loadProfile());
      setResumeFile(await loadResumeFile());
      setLlmConfigured(Boolean((await loadSettings()).llmBaseUrl && (await loadSettings()).llmModel));
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

  const handleResumeFile = useCallback(async (f: StoredFile | null) => {
    await saveResumeFile(f);
    setResumeFile(f);
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

      setStageLabel(`Matching ${detected.fields.length} fields against your profile…`);
      const analyzed: AnalyzedField[] = [];
      const ambiguous: FieldDescriptor[] = [];

      for (const field of detected.fields) {
        const sensitive = isSensitive(field);
        if (field.type === 'file') {
          // Resume auto-attach: only fields that clearly ask for a CV/resume.
          const looksLikeResume = /resume|\bcv\b|curriculum/i.test(`${field.label} ${field.context} ${field.name}`);
          analyzed.push({
            field,
            sensitive: false,
            included: looksLikeResume && Boolean(resumeFile),
            suggestion: {
              fieldId: field.id,
              value: looksLikeResume && resumeFile ? resumeFile.name : null,
              confidence: looksLikeResume && resumeFile ? 0.9 : 0,
              source: 'profile',
              reason:
                looksLikeResume && resumeFile
                  ? `Attach saved resume file (${resumeFile!.name}).`
                  : 'File upload — no matching saved file. Attach manually.',
            },
          });
          continue;
        }
        if (sensitive) {
          analyzed.push({
            field,
            sensitive,
            included: false,
            suggestion: {
              fieldId: field.id,
              value: null,
              confidence: 0,
              source: 'unresolved',
              reason: 'Sensitive field — manual entry required.',
            },
          });
          continue;
        }
        const det = deterministicMatch(field, profile);
        if (det) {
          analyzed.push({ field, sensitive, included: det.value !== null, suggestion: det });
        } else {
          analyzed.push({ field, sensitive, included: true, suggestion: { fieldId: field.id, value: null, confidence: 0, source: 'unresolved', reason: '' } });
          ambiguous.push(field);
        }
      }

      if (ambiguous.length > 0) {
        const settings = await loadSettings();
        if (settings.llmBaseUrl && settings.llmModel) {
          setStageLabel(`Asking the AI about ${ambiguous.length} open question${ambiguous.length > 1 ? 's' : ''}…`);
          try {
            const llm = await suggestWithLlm(
              ambiguous,
              profile,
              { baseUrl: settings.llmBaseUrl, apiKey: settings.llmApiKey, model: settings.llmModel },
            );
            for (const a of analyzed) {
              const s = llm.get(a.field.id);
              // Only fill gaps: deterministic matches always win.
              if (s && !a.sensitive && a.suggestion.source === 'unresolved') {
                a.suggestion = s;
                a.included = s.value !== null && s.confidence >= 0.7;
              }
            }
          } catch (e) {
            setNotice(e instanceof Error ? e.message : 'AI suggestions failed; showing deterministic matches only.');
          }
        } else {
          setNotice('AI suggestions are off — add an LLM endpoint in Settings to resolve open questions.');
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
        .map((f) => ({ fieldId: f.field.id, value: f.suggestion.value! }));
      const attachResume = analysis.fields.some((f) => f.included && f.field.type === 'file');
      const { results } = await fillFields(values, attachResume ? resumeFile ?? undefined : undefined);
      const byId = new Map(results.map((r) => [r.fieldId, r.status]));
      setAnalysis((prev) =>
        prev ? { ...prev, fields: prev.fields.map((f) => ({ ...f, fillStatus: byId.get(f.field.id) })) } : prev,
      );
      setPhase('filled');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('ready');
    }
  }, [analysis]);

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
            onUpdateField={updateField}
            onGoToSettings={() => setTab('settings')}
            hasProfile={Boolean(profile)}
          />
        )}
        {tab === 'profile' && profile && (
          <ProfileForm
            initial={profile}
            onSave={(p) => void handleSaveProfile(p)}
            resumeFile={resumeFile}
            onResumeFile={(f) => void handleResumeFile(f)}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            onLoad={loadSettings}
            onSave={async (s) => {
              await saveSettings(s);
              setLlmConfigured(Boolean(s.llmBaseUrl && s.llmModel));
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
