import { useEffect, useState } from 'react';
import type { Profile, StoredFile } from '../../shared/types';
import { emptyProfile } from '../../shared/schema';

interface Props {
  initial: Profile;
  onSave: (p: Profile) => void;
  resumeFile: StoredFile | null;
  onResumeFile: (f: StoredFile | null) => void;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function LoadFileButton({ onText }: { onText: (t: string) => void }) {
  return (
    <label className="btn-link">
      Load .txt / .md file
      <input
        type="file"
        accept=".txt,.md,text/plain"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then((t) => onText(t));
          e.target.value = '';
        }}
      />
    </label>
  );
}

export function ProfileForm({ initial, onSave, resumeFile, onResumeFile }: Props) {
  const [p, setP] = useState<Profile>(initial);
  const [saved, setSaved] = useState(false);

  const pickResume = (input: HTMLInputElement) => {
    const f = input.files?.[0];
    if (!f) return;
    void f.arrayBuffer().then((buf) => {
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      onResumeFile({ name: f.name, type: f.type || 'application/octet-stream', data: btoa(bin) });
    });
    input.value = '';
  };

  useEffect(() => setP(initial), [initial]);

  const set = (patch: (draft: Profile) => void) => {
    const next = structuredClone(p);
    patch(next);
    setP(next);
    setSaved(false);
  };

  const save = () => {
    onSave(p);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="profile">
      <section className="card">
        <h2>Personal</h2>
        <div className="grid-2">
          <Field label="First name" value={p.personal.firstName} onChange={(v) => set((d) => void (d.personal.firstName = v))} placeholder="e.g. Priya" />
          <Field label="Last name" value={p.personal.lastName} onChange={(v) => set((d) => void (d.personal.lastName = v))} placeholder="e.g. Sharma" />
          <Field label="Full name" value={p.personal.fullName} onChange={(v) => set((d) => void (d.personal.fullName = v))} placeholder="Left empty → first + last" />
          <Field label="Preferred name" value={p.personal.preferredName} onChange={(v) => set((d) => void (d.personal.preferredName = v))} placeholder="e.g. Pri" />
        </div>
      </section>

      <section className="card">
        <h2>Contact</h2>
        <div className="grid-2">
          <Field label="Email" type="email" value={p.contact.email} onChange={(v) => set((d) => void (d.contact.email = v))} placeholder="you@example.com" />
          <Field label="Phone" type="tel" value={p.contact.phone} onChange={(v) => set((d) => void (d.contact.phone = v))} placeholder="+91 98765 43210" />
          <Field label="LinkedIn" value={p.contact.linkedin} onChange={(v) => set((d) => void (d.contact.linkedin = v))} placeholder="linkedin.com/in/you" />
          <Field label="GitHub" value={p.contact.github} onChange={(v) => set((d) => void (d.contact.github = v))} placeholder="github.com/you" />
          <Field label="Website" value={p.contact.website} onChange={(v) => set((d) => void (d.contact.website = v))} placeholder="yoursite.com" />
        </div>
      </section>

      <section className="card">
        <h2>Education</h2>
        {p.education.length === 0 && <p className="empty">No education entries yet.</p>}
        {p.education.map((edu, i) => (
          <div className="entry" key={i}>
            <div className="grid-2">
              <Field label="Institution" value={edu.institution} onChange={(v) => set((d) => void (d.education[i].institution = v))} placeholder="University name" />
              <Field label="Degree" value={edu.degree} onChange={(v) => set((d) => void (d.education[i].degree = v))} placeholder="B.Tech, M.Sc, PhD…" />
              <Field label="Field of study" value={edu.field} onChange={(v) => set((d) => void (d.education[i].field = v))} placeholder="Computer Science" />
              <div className="grid-2">
                <Field label="Start year" value={edu.startYear} onChange={(v) => set((d) => void (d.education[i].startYear = v))} placeholder="2018" />
                <Field label="End year" value={edu.endYear} onChange={(v) => set((d) => void (d.education[i].endYear = v))} placeholder="2022" />
              </div>
            </div>
            <button className="btn-link danger" onClick={() => set((d) => void d.education.splice(i, 1))}>Remove</button>
          </div>
        ))}
        <button className="btn-link" onClick={() => set((d) => void d.education.push(emptyProfile().education[0] ?? { institution: '', degree: '', field: '', startYear: '', endYear: '' }))}>+ Add education</button>
      </section>

      <section className="card">
        <h2>Experience</h2>
        {p.experience.length === 0 && <p className="empty">No experience entries yet.</p>}
        {p.experience.map((exp, i) => (
          <div className="entry" key={i}>
            <div className="grid-2">
              <Field label="Company" value={exp.company} onChange={(v) => set((d) => void (d.experience[i].company = v))} placeholder="Acme Corp" />
              <Field label="Title" value={exp.title} onChange={(v) => set((d) => void (d.experience[i].title = v))} placeholder="Software Engineer" />
              <Field label="Start date" value={exp.startDate} onChange={(v) => set((d) => void (d.experience[i].startDate = v))} placeholder="2022-01 or Jan 2022" />
              <Field label="End date" value={exp.endDate} onChange={(v) => set((d) => void (d.experience[i].endDate = v))} placeholder="Present" />
            </div>
            <label className="field">
              <span className="field-label">Description</span>
              <textarea rows={3} value={exp.description} onChange={(e) => set((d) => void (d.experience[i].description = e.target.value))} placeholder="What you worked on and its impact" />
            </label>
            <Field label="Technologies" value={exp.technologies} onChange={(v) => set((d) => void (d.experience[i].technologies = v))} placeholder="TypeScript, React, Python" />
            <button className="btn-link danger" onClick={() => set((d) => void d.experience.splice(i, 1))}>Remove</button>
          </div>
        ))}
        <button
          className="btn-link"
          onClick={() =>
            set((d) =>
              void d.experience.push({ company: '', title: '', startDate: '', endDate: '', description: '', technologies: '' }),
            )
          }
        >
          + Add experience
        </button>
      </section>

      <section className="card">
        <h2>Skills</h2>
        <label className="field">
          <span className="field-label">Comma-separated skills</span>
          <textarea
            rows={2}
            value={p.skills.join(', ')}
            onChange={(e) =>
              set((d) => void (d.skills = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)))
            }
            placeholder="Python, SQL, Kubernetes…"
          />
        </label>
      </section>

      <section className="card">
        <h2>Preferences</h2>
        <div className="grid-2">
          <Field label="Willing to relocate" value={p.preferences.relocate} onChange={(v) => set((d) => void (d.preferences.relocate = v))} placeholder="Yes / No / Within India only" />
          <Field label="Preferred work mode" value={p.preferences.workMode} onChange={(v) => set((d) => void (d.preferences.workMode = v))} placeholder="Remote / Hybrid / On-site" />
        </div>
        <Field label="Preferred locations" value={p.preferences.locations} onChange={(v) => set((d) => void (d.preferences.locations = v))} placeholder="Bengaluru, Pune" />
      </section>

      <section className="card">
        <h2>Standard answers</h2>
        <p className="hint">Reusable answers for questions you see often, e.g. "Why do you want to work here?"</p>
        {p.standardAnswers.length === 0 && <p className="empty">No saved answers yet.</p>}
        {p.standardAnswers.map((sa, i) => (
          <div className="entry" key={i}>
            <Field label="Question" value={sa.question} onChange={(v) => set((d) => void (d.standardAnswers[i].question = v))} placeholder="Why are you interested in this role?" />
            <label className="field">
              <span className="field-label">Answer</span>
              <textarea rows={3} value={sa.answer} onChange={(e) => set((d) => void (d.standardAnswers[i].answer = e.target.value))} />
            </label>
            <button className="btn-link danger" onClick={() => set((d) => void d.standardAnswers.splice(i, 1))}>Remove</button>
          </div>
        ))}
        <button className="btn-link" onClick={() => set((d) => void d.standardAnswers.push({ question: '', answer: '' }))}>+ Add standard answer</button>
      </section>

      <section className="card">
        <h2>Resume file (auto-attach)</h2>
        <p className="hint">
          Your actual resume file (PDF/DOC). Forms with a "Upload resume" field will offer to attach
          it — only after you review and confirm. Stored locally in your browser.
        </p>
        {resumeFile ? (
          <div className="entry">
            📄 {resumeFile.name}{' '}
            <button className="btn-link danger" onClick={() => onResumeFile(null)}>Remove</button>
          </div>
        ) : (
          <label className="btn-link">
            Choose file…
            <input
              type="file"
              accept=".pdf,.doc,.docx,.rtf"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files && pickResume(e.target)}
            />
          </label>
        )}
      </section>

      <section className="card">
        <h2>Context documents</h2>
        <p className="hint">
          Paste or load your resume and portfolio text. The AI mines these for projects,
          metrics and skills when answering open-ended questions. Stored locally, sent only
          to your AI endpoint.
        </p>
        <label className="field">
          <span className="field-label">Resume</span>
          <textarea
            rows={8}
            value={p.documents.resume}
            onChange={(e) => set((d) => void (d.documents.resume = e.target.value))}
            placeholder="Paste your resume text here…"
          />
        </label>
        <LoadFileButton onText={(t) => set((d) => void (d.documents.resume = t))} />
        <label className="field" style={{ marginTop: 10 }}>
          <span className="field-label">Portfolio</span>
          <textarea
            rows={6}
            value={p.documents.portfolio}
            onChange={(e) => set((d) => void (d.documents.portfolio = e.target.value))}
            placeholder="Paste your portfolio / project descriptions here…"
          />
        </label>
        <LoadFileButton onText={(t) => set((d) => void (d.documents.portfolio = t))} />
      </section>

      <div className="save-bar">
        <button className="btn primary" onClick={save}>Save profile</button>
        {saved && <span className="save-ok">Saved ✓</span>}
        <span style={{ flex: 1 }} />
        <button
          className="btn-link"
          onClick={() => {
            const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'ai-form-profile.json';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Export
        </button>
        <label className="btn-link">
          Import
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              void f.text().then((t) => {
                try {
                  setP({ ...emptyProfile(), ...JSON.parse(t) });
                  setSaved(false);
                } catch {
                  alert('Not a valid profile export file.');
                }
              });
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </div>
  );
}
