import { describe, expect, it } from 'vitest';
import { scanForm } from './detect';

function doc(html: string): Document {
  const d = new DOMParser().parseFromString(html, 'text/html');
  // happy-dom checkVisibility may not exist; detect falls back gracefully.
  return d;
}

describe('form detection', () => {
  it('detects label[for] association', () => {
    const { fields } = scanForm(doc(`
      <label for="fn">First name</label><input id="fn" type="text">
    `));
    expect(fields).toHaveLength(1);
    expect(fields[0].label).toBe('First name');
    expect(fields[0].type).toBe('text');
  });

  it('detects wrapping labels', () => {
    const { fields } = scanForm(doc(`<label>Email <input type="email"></label>`));
    expect(fields[0].label).toBe('Email');
    expect(fields[0].type).toBe('email');
  });

  it('falls back to aria-label', () => {
    const { fields } = scanForm(doc(`<input type="text" aria-label="Years of experience">`));
    expect(fields[0].label).toBe('Years of experience');
  });

  it('falls back to aria-labelledby', () => {
    const { fields } = scanForm(doc(`
      <span id="q1">Highest education</span><input type="text" aria-labelledby="q1">
    `));
    expect(fields[0].label).toBe('Highest education');
  });

  it('falls back to placeholder', () => {
    const { fields } = scanForm(doc(`<input type="text" placeholder="Enter your phone">`));
    expect(fields[0].label).toBe('Enter your phone');
    expect(fields[0].placeholder).toBe('Enter your phone');
  });

  it('humanizes the name attribute as a last resort', () => {
    const { fields } = scanForm(doc(`<input type="text" name="candidate_first_name">`));
    expect(fields[0].label).toBe('candidate first name');
  });

  it('groups radio buttons into one field with options', () => {
    const { fields } = scanForm(doc(`
      <fieldset><legend>Willing to relocate?</legend>
        <input type="radio" name="reloc" value="yes"><input type="radio" name="reloc" value="no">
      </fieldset>
    `));
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('radio');
    expect(fields[0].options).toEqual(['yes', 'no']);
    expect(fields[0].context).toBe('Willing to relocate?');
  });

  it('uses option labels for radios wrapped in labels', () => {
    const { fields } = scanForm(doc(`
      <label><input type="radio" name="r" value="y"> Yes</label>
      <label><input type="radio" name="r" value="n"> No</label>
    `));
    expect(fields[0].options).toEqual(['Yes', 'No']);
  });

  it('groups multiple same-name checkboxes', () => {
    const { fields } = scanForm(doc(`
      <label><input type="checkbox" name="skills" value="py"> Python</label>
      <label><input type="checkbox" name="skills" value="go"> Go</label>
    `));
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('checkbox-group');
    expect(fields[0].options).toEqual(['Python', 'Go']);
  });

  it('treats a lone checkbox as a single field', () => {
    const { fields } = scanForm(doc(`<label><input type="checkbox" name="agree"> I agree</label>`));
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('checkbox');
  });

  it('collects select options, skipping placeholder options', () => {
    const { fields } = scanForm(doc(`
      <select><option value="">--Select--</option><option>Remote</option><option>Hybrid</option></select>
    `));
    expect(fields[0].type).toBe('select');
    expect(fields[0].options).toEqual(['Remote', 'Hybrid']);
  });

  it('finds fields outside any <form> element', () => {
    const { fields } = scanForm(doc(`<div><label for="a">Name</label><input id="a"></div>`));
    expect(fields).toHaveLength(1);
  });

  it('ignores hidden, submit and disabled controls', () => {
    const { fields } = scanForm(doc(`
      <input type="hidden" name="csrf">
      <input type="submit" value="Submit">
      <input type="text" disabled aria-label="Disabled">
      <input type="text" aria-label="Visible">
    `));
    expect(fields.map((f) => f.label)).toEqual(['Visible']);
  });

  it('marks required state from attribute and aria-required', () => {
    const { fields } = scanForm(doc(`
      <input aria-label="a" required><input aria-label="b" aria-required="true"><input aria-label="c">
    `));
    expect(fields.map((f) => f.required)).toEqual([true, true, false]);
  });

  it('assigns internal ids independent of DOM ids', () => {
    const { fields } = scanForm(doc(`
      <input aria-label="one"><input aria-label="two"><textarea aria-label="three"></textarea>
    `));
    expect(new Set(fields.map((f) => f.id)).size).toBe(3);
    expect(fields[2].type).toBe('textarea');
  });

  it('keeps field ids stable when new fields are inserted before existing ones', () => {
    const d = doc(`<div id="host"><input aria-label="one"><input aria-label="two"></div>`);
    const first = scanForm(d);
    // A new field appears at the top of the page (dynamic forms do this).
    const fresh = d.createElement('input');
    fresh.setAttribute('aria-label', 'zero');
    d.getElementById('host')!.prepend(fresh);
    const second = scanForm(d);
    expect(second.fields).toHaveLength(3);
    expect(second.fields.find((f) => f.label === 'one')!.id).toBe(first.fields[0].id);
    expect(second.fields.find((f) => f.label === 'two')!.id).toBe(first.fields[1].id);
    const newId = second.fields.find((f) => f.label === 'zero')!.id;
    expect(new Set([first.fields[0].id, first.fields[1].id]).has(newId)).toBe(false);
  });
});
