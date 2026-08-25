import { useState } from 'react';
import type { AnalyzedField } from '../App';
import type { FillResult } from '../../shared/types';
import { confidenceBand } from '../../shared/types';

interface Props {
  analyzable: boolean;
  phase: 'idle' | 'analyzing' | 'ready' | 'filling' | 'filled';
  stageLabel: string;
  error: string | null;
  notice: string | null;
  llmConfigured: boolean;
  analysis: { fields: AnalyzedField[]; domVersion: number } | null;
  onAnalyze: () => void;
  onFill: () => void;
  onFillField: (fieldId: string, value: string, kind: string) => void;
  onUpdateField: (fieldId: string, patch: Partial<AnalyzedField>) => void;
  onGoToSettings: () => void;
  hasProfile: boolean;
}

const BAND_META = {
  high: { icon: '✓', cls: 'band-high', label: 'High' },
  medium: { icon: '⚠', cls: 'band-medium', label: 'Medium' },
  low: { icon: '?', cls: 'band-low', label: 'Low' },
} as const;

function FieldRow({
  f,
  onUpdate,
  onFillField,
  phase,
}: {
  f: AnalyzedField;
  onUpdate: Props['onUpdateField'];
  onFillField: Props['onFillField'];
  phase: Props['phase'];
}) {
  const [open, setOpen] = useState(false);
  const s = f.suggestion;
  const band = confidenceBand(s.confidence);
  const meta = BAND_META[band];
  const filledOk = f.fillStatus === 'filled';

  if (f.sensitive) {
    return (
      <div className="row sensitive">
        <span className="row-icon">🔒</span>
        <div className="row-body">
          <div className="row-label">{f.field.label || f.field.placeholder || f.field.name || f.field.type}</div>
          <div className="row-sub">Sensitive field — manual entry required</div>
        </div>
      </div>
    );
  }

  const displayValue = s.value ?? '';
  const unresolved = s.value === null;

  return (
    <div className={`row ${open ? 'open' : ''} ${filledOk ? 'is-filled' : ''}`}>
      <div
        className="row-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
      >
        <span className={`row-icon ${meta.cls}`}>{filledOk ? '✓' : meta.icon}</span>
        <span className="row-body">
          <span className="row-label">{f.field.label || f.field.placeholder || f.field.name || f.field.type}</span>
          <span className="row-value-preview">
            {unresolved ? <em>No information available</em> : s.value}
            {f.fillStatus === 'filled' && <span className="pill ok">filled</span>}
            {f.fillStatus === 'failed' && <span className="pill fail" title={f.fillDetail}>couldn't fill{f.fillDetail ? ` — ${f.fillDetail}` : ''}</span>}
            {f.fillStatus === 'not-found' && <span className="pill fail">not found on page</span>}
          </span>
        </span>
        {!unresolved && (
          <label className="include" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={f.included}
              onChange={(e) => onUpdate(f.field.id, { included: e.target.checked })}
              aria-label={`Include ${f.field.label}`}
            />
          </label>
        )}
        <button
          className="btn-mini"
          disabled={unresolved || f.fillStatus === 'filled' || phase === 'filling'}
          onClick={(e) => {
            e.stopPropagation();
            if (!s.value) return;
            onUpdate(f.field.id, { included: true });
            onFillField(f.field.id, s.value, f.field.type);
          }}
          title="Fill just this field"
        >
          {f.fillStatus === 'filled' ? 'Done' : 'Apply'}
        </button>
      </div>

      {open && (
        <div className="row-detail">
          {(f.field.context || f.field.options.length > 0) && (
            <div className="detail-meta">
              {f.field.context && <p className="detail-context">{f.field.context}</p>}
              {f.field.options.length > 0 && <p className="detail-options">Options: {f.field.options.join(' · ')}</p>}
            </div>
          )}
          <label className="field">
            <span className="field-label">Answer (editable)</span>
            <input
              value={displayValue}
              placeholder={unresolved ? 'No suggestion — type a value to fill manually approved text' : ''}
              onChange={(e) =>
                onUpdate(f.field.id, {
                  suggestion: { ...s, value: e.target.value === '' ? null : e.target.value, source: s.source === 'unresolved' ? 'llm' : s.source },
                  included: e.target.value !== '',
                })
              }
            />
          </label>
          <div className="detail-foot">
            <span className={`conf ${meta.cls}`}>
              {meta.label} confidence · {Math.round(s.confidence * 100)}%
            </span>
            {s.reason && <span className="reason">{s.reason}</span>}
            <button
              className="btn small primary"
              disabled={unresolved || !displayValue || f.fillStatus === 'filled' || phase === 'filling'}
              onClick={() => {
                onUpdate(f.field.id, { included: true });
                onFillField(f.field.id, displayValue, f.field.type);
              }}
            >
              {f.fillStatus === 'filled' ? 'Filled' : 'Apply to page'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AnalysisView(p: Props) {
  const { analysis, phase } = p;
  const fields = analysis?.fields ?? [];
  const counts = {
    total: fields.length,
    high: fields.filter((f) => !f.sensitive && f.suggestion.value !== null && confidenceBand(f.suggestion.confidence) === 'high').length,
    review: fields.filter((f) => !f.sensitive && f.suggestion.value !== null && confidenceBand(f.suggestion.confidence) !== 'high').length,
    unresolved: fields.filter((f) => !f.sensitive && f.suggestion.value === null).length,
    sensitive: fields.filter((f) => f.sensitive).length,
  };
  const approvedCount = fields.filter((f) => f.included && f.suggestion.value).length;
  const filledCount = fields.filter((f) => f.fillStatus === 'filled').length;
  const attentionCount = counts.total - counts.sensitive - filledCount;

  return (
    <div className="analysis">
      {!p.hasProfile && (
        <div className="banner info">
          Add your information first so the assistant can answer for you.
          <button className="btn small" onClick={() => document.querySelector<HTMLButtonElement>('.tabs button:nth-child(2)')?.click()}>
            Open Profile
          </button>
        </div>
      )}

      {!p.analyzable && (
        <div className="banner warn">This page can't be analyzed. Navigate to an http(s) page with a form.</div>
      )}

      {phase === 'idle' && fields.length === 0 && p.analyzable && (
        <div className="empty-state">
          <div className="empty-icon">⌘</div>
          <h3>Ready when you are</h3>
          <p>Open a page with a form, then analyze it. You'll review every suggestion before anything is filled.</p>
          <button className="btn primary" disabled={!p.hasProfile} onClick={p.onAnalyze}>
            Analyze Form
          </button>
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="loading">
          <div className="spinner" aria-hidden />
          <p>{p.stageLabel}</p>
        </div>
      )}

      {phase === 'filling' && (
        <div className="loading">
          <div className="spinner" aria-hidden />
          <p>Filling approved fields…</p>
        </div>
      )}

      {phase === 'filled' && (
        <div className="banner success">
          {filledCount} field{filledCount === 1 ? '' : 's'} filled successfully.
          {attentionCount > 0 && <> {attentionCount} still need{attentionCount === 1 ? 's' : ''} your attention.</>}
          {' '}Review the page and submit manually.
        </div>
      )}

      {p.error && <div className="banner error">{p.error}</div>}
      {p.notice && <div className="banner info">{p.notice}</div>}

      {fields.length > 0 && phase !== 'analyzing' && (
        <>
          <div className="summary">
            <div className="summary-title">Form detected · {counts.total} field{counts.total === 1 ? '' : 's'}</div>
            <div className="summary-stats">
              <span className="stat hi">✓ {counts.high} confident</span>
              <span className="stat mid">⚠ {counts.review} need review</span>
              <span className="stat lo">? {counts.unresolved} unresolved</span>
              {counts.sensitive > 0 && <span className="stat sens">🔒 {counts.sensitive} sensitive</span>}
            </div>
          </div>

          <div className="rows">
            {fields.map((f) => (
              <FieldRow
                key={f.field.id}
                f={f}
                onUpdate={p.onUpdateField}
                onFillField={p.onFillField}
                phase={p.phase}
              />
            ))}
          </div>

          <div className="actions">
            <button className="btn primary" disabled={approvedCount === 0 || phase === 'filling'} onClick={p.onFill}>
              Fill All Approved ({approvedCount})
            </button>
            <button className="btn" onClick={p.onAnalyze}>Re-analyze</button>
          </div>
          <p className="hint center">The extension never submits forms — you press the final button.</p>
        </>
      )}

      {fields.length === 0 && phase === 'ready' && p.analyzable && (
        <div className="empty-state">
          <h3>No form fields found</h3>
          <p>No fillable inputs were detected on this page. If the form loads after scrolling or clicking, try Re-analyze.</p>
        </div>
      )}

      {!p.llmConfigured && phase === 'idle' && (
        <p className="hint center">
          Optional: configure an AI endpoint in{' '}
          <button className="btn-link" onClick={p.onGoToSettings}>Settings</button>{' '}
          to answer open-ended questions.
        </p>
      )}
    </div>
  );
}
