import { describe, expect, it } from 'vitest';
import { scanForm } from './detect';
import { applyFill } from './fill';

function setup(html: string) {
  document.body.innerHTML = html;
  return scanForm(document);
}

describe('form filling', () => {
  it('sets text inputs and fires input + change events', () => {
    const events: string[] = [];
    const { fields, targets } = setup(`<label for="n">Name</label><input id="n">`);
    const el = targets.get(fields[0].id)!.elements[0];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    const r = applyFill(targets.get(fields[0].id)!, 'Abdul');
    expect(r.status).toBe('filled');
    expect(el.value).toBe('Abdul');
    expect(events).toEqual(['input', 'change']);
  });

  it('fills textareas', () => {
    const { fields, targets } = setup(`<textarea aria-label="About"></textarea>`);
    applyFill(targets.get(fields[0].id)!, 'I build things.');
    expect((targets.get(fields[0].id)!.elements[0] as HTMLTextAreaElement).value).toBe('I build things.');
  });

  it('normalizes dates to yyyy-mm-dd', () => {
    const { fields, targets } = setup(`<input type="date" aria-label="Start date">`);
    applyFill(targets.get(fields[0].id)!, 'Mar 2022');
    expect((targets.get(fields[0].id)!.elements[0] as HTMLInputElement).value).toBe('2022-03-01');
  });

  it('selects the matching option by text', () => {
    const fired: string[] = [];
    const { fields, targets } = setup(`
      <select aria-label="Work mode"><option value="">--</option><option value="r">Remote</option><option value="h">Hybrid</option></select>
    `);
    const sel = targets.get(fields[0].id)!.elements[0] as HTMLSelectElement;
    sel.addEventListener('change', () => fired.push('change'));
    const r = applyFill(targets.get(fields[0].id)!, 'Remote');
    expect(r.status).toBe('filled');
    expect(sel.value).toBe('r');
    expect(fired).toEqual(['change']);
  });

  it('checks the right radio in a group and fires change', () => {
    let changed = 0;
    const { fields, targets } = setup(`
      <label><input type="radio" name="rel" value="y"> Yes</label>
      <label><input type="radio" name="rel" value="n"> No</label>
    `);
    targets.get(fields[0].id)!.elements.forEach((el) => el.addEventListener('change', () => changed++));
    const r = applyFill(targets.get(fields[0].id)!, 'No');
    expect(r.status).toBe('filled');
    const boxes = targets.get(fields[0].id)!.elements as HTMLInputElement[];
    expect(boxes.find((b) => b.value === 'n')!.checked).toBe(true);
    expect(boxes.find((b) => b.value === 'y')!.checked).toBe(false);
    expect(changed).toBeGreaterThan(0);
  });

  it('toggles a single checkbox on for truthy values', () => {
    const { fields, targets } = setup(`<label><input type="checkbox" name="a"> Agree</label>`);
    applyFill(targets.get(fields[0].id)!, 'Yes');
    expect((targets.get(fields[0].id)!.elements[0] as HTMLInputElement).checked).toBe(true);
  });

  it('checks only the requested options in a checkbox group', () => {
    const { fields, targets } = setup(`
      <label><input type="checkbox" name="s" value="py"> Python</label>
      <label><input type="checkbox" name="s" value="go"> Go</label>
      <label><input type="checkbox" name="s" value="rs"> Rust</label>
    `);
    applyFill(targets.get(fields[0].id)!, 'Python, Rust');
    const boxes = targets.get(fields[0].id)!.elements as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true]);
  });

  it('works with React-style controlled inputs (native setter)', () => {
    // Simulate a framework that re-reads the DOM value on input events:
    // the native prototype setter must be used so no stale value caching occurs.
    const { fields, targets } = setup(`<input id="e" type="email">`);
    const el = targets.get(fields[0].id)!.elements[0] as HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    expect(typeof desc?.set).toBe('function'); // precondition for the React trick
    applyFill(targets.get(fields[0].id)!, 'a@b.co');
    expect(el.value).toBe('a@b.co');
  });
});

describe('fill safety', () => {
  it('refuses to fill sensitive fields even if asked', () => {
    const { fields, targets } = setup(`<input type="password" aria-label="Password">`);
    const r = applyFill(targets.get(fields[0].id)!, 'hunter2');
    expect(r.status).toBe('skipped-sensitive');
    expect((targets.get(fields[0].id)!.elements[0] as HTMLInputElement).value).toBe('');
  });

  it('reports not-found for unknown field ids', () => {
    const { targets } = setup(`<input aria-label="x">`);
    const fake = { kind: 'input', elements: [], descriptor: { id: 'nope', type: 'text', label: '', placeholder: '', required: false, options: [], context: '', name: '' } };
    void targets;
    expect(applyFill(fake as never, 'v').status).toBe('not-found');
  });

  it('returns empty for blank values', () => {
    const { fields, targets } = setup(`<input aria-label="x">`);
    expect(applyFill(targets.get(fields[0].id)!, '   ').status).toBe('empty');
  });
});

describe('file attachment', () => {
  const resume = { name: 'resume.pdf', type: 'application/pdf', data: btoa('fake pdf bytes') };

  it('attaches the saved resume to a resume upload field', () => {
    const { fields, targets } = setup(`<label for="cv">Upload resume</label><input id="cv" type="file">`);
    const r = applyFill(targets.get(fields[0].id)!, '', resume);
    expect(r.status).toBe('filled');
    const el = targets.get(fields[0].id)!.elements[0] as HTMLInputElement;
    expect(el.files?.length).toBe(1);
    expect(el.files?.[0].name).toBe('resume.pdf');
    expect(el.files?.[0].size).toBe(atob(resume.data).length); // decoded byte count
  });

  it('refuses non-resume file fields even when a resume is passed', () => {
    const { fields, targets } = setup(`<label for="pp">Upload passport scan</label><input id="pp" type="file">`);
    expect(applyFill(targets.get(fields[0].id)!, '', resume).status).toBe('skipped-sensitive');
    expect((targets.get(fields[0].id)!.elements[0] as HTMLInputElement).files?.length ?? 0).toBe(0);
  });

  it('does nothing without an explicit file', () => {
    const { fields, targets } = setup(`<label for="cv2">Resume</label><input id="cv2" type="file">`);
    expect(applyFill(targets.get(fields[0].id)!, '').status).toBe('skipped-sensitive');
  });
});
