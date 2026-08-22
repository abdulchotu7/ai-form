import type { FillResult, FillStatus } from '../shared/types';
import type { FillTarget } from './detect';
import { isSensitive } from '../shared/match';

/**
 * Deterministic DOM filling. Only explicitly implemented operations —
 * set value / check control / select option. Never clicks buttons,
 * never navigates, never submits.
 */

/**
 * Set value through the native prototype setter so React/Vue/Angular notice,
 * then fire the full typing sequence. Some validators (Google Forms) ignore
 * bare input events or untrusted ones — focusing + keydown/input(InputEvent)/keyup
 * clears most of them.
 */
/** Accept masked-input reformatting: "(630) 199-9626" or "+1 630 199 9626" still match "6301999626". */
export function valuesMatch(actual: string | null | undefined, expected: string): boolean {
  if (actual === expected) return true;
  const strip = (s: string) => s.replace(/[\s()\-.+/]/g, '');
  const a = strip(actual ?? '');
  const e = strip(expected);
  if (a === e) return true;
  // Masks may also prepend country codes / currency symbols — compare digit tails.
  const da = a.replace(/\D/g, '');
  const de = e.replace(/\D/g, '');
  return da !== '' && de !== '' && (da.endsWith(de) || de.endsWith(da));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  // ponytail: InputEvent is still isTrusted:false — if a form still rejects
  // fills, the upgrade path is chrome.debugger + CDP Input.insertText.
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value.slice(-1), inputType: 'insertText' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function truthy(v: string): boolean {
  return /^(y(es)?|true|1|on|check(ed)?)$/i.test(v.trim());
}

function normalizeDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // Accept common formats like "Mar 2020", "2020", "03/2020" → first of month.
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const m = v.toLowerCase().match(new RegExp(`(${monthNames.join('|')})[a-z]*[ ,]+(\\d{4})`));
  if (m) return `${m[2]}-${String(monthNames.indexOf(m[1]) + 1).padStart(2, '0')}-01`;
  const yearOnly = v.match(/\b(19|20)\d{2}\b/);
  if (yearOnly && /^(19|20)\d{2}$/.test(v)) return `${v}-01-01`;
  // Parse as UTC to avoid the local-timezone shift moving the date a day
  // backwards via toISOString() (e.g. "03/01/2020" in IST → 2020-02-29 UTC).
  const m2 = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m2) return `${m2[3]}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  const d = new Date(`${v.trim()} UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function fillSelect(select: HTMLSelectElement, value: string): boolean {
  const nv = value.trim().toLowerCase();
  let option =
    Array.from(select.options).find((o) => o.value.toLowerCase() === nv || o.text.trim().toLowerCase() === nv) ??
    Array.from(select.options).find((o) => o.text.trim().toLowerCase().includes(nv) || nv.includes(o.text.trim().toLowerCase()));
  if (!option && /^\d+$/.test(value.trim())) {
    const idx = parseInt(value, 10);
    option = Array.from(select.options).find((o) => o.text.trim() === String(idx));
  }
  if (!option || option.disabled) return false;
  select.value = option.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function fillRadio(group: HTMLInputElement[], value: string): boolean {
  const nv = value.trim().toLowerCase();
  const target =
    group.find((r) => r.value.toLowerCase() === nv) ??
    group.find((r) => (r.labels?.[0]?.textContent ?? '').trim().toLowerCase() === nv) ??
    group.find((r) => (r.value.toLowerCase().includes(nv) || nv.includes(r.value.toLowerCase())) && r.value !== '');
  if (!target || target.disabled) return false;
  target.click(); // click() fires input+change and updates checked state
  return true;
}

function fillCheckbox(box: HTMLInputElement, value: string): boolean {
  if (box.disabled) return false;
  const want = truthy(value);
  if (box.checked !== want) box.click();
  return true;
}

export function applyFill(target: FillTarget, rawValue: string): FillResult {
  const status = (s: FillStatus): FillResult => ({ fieldId: target.descriptor.id, status: s });

  // File inputs are never touched — the user attaches files themselves.
  if (target.kind === 'file') return status('skipped-sensitive');
  if (isSensitive(target.descriptor)) return status('skipped-sensitive');
  if (!target.elements[0]) return status('not-found');
  const value = rawValue;
  if (!value || !value.trim()) return status('empty');

  switch (target.kind) {
    case 'input': {
      const el = target.elements[0] as HTMLInputElement;
      if (el.disabled) return status('failed');
      let v = value.trim();
      if (el.type === 'date') {
        const d = normalizeDate(v);
        if (!d) return status('failed');
        v = d;
      }
      if (el.type === 'number') v = v.replace(/[,\s]/g, '');
      try {
        setNativeValue(el, v);
      } catch {
        return status('failed');
      }
      if (!valuesMatch(el.value, v)) {
        // Fallback: some frameworks' value trackers swallow the prototype
        // setter, and masks may revert it. Write directly and re-fire.
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return valuesMatch(el.value, v)
        ? status('filled')
        : { fieldId: target.descriptor.id, status: 'failed', detail: `page kept "${el.value.slice(0, 40)}" instead of "${v.slice(0, 40)}"` };
    }
    case 'textarea': {
      const el = target.elements[0] as HTMLTextAreaElement;
      if (el.disabled) return status('failed');
      try {
        setNativeValue(el, value);
      } catch {
        return status('failed');
      }
      return el.value === value ? status('filled') : status('failed');
    }
    case 'select':
      return fillSelect(target.elements[0] as HTMLSelectElement, value) ? status('filled') : status('failed');
    case 'radio':
      return fillRadio(target.elements as HTMLInputElement[], value) ? status('filled') : status('failed');
    case 'checkbox':
      return fillCheckbox(target.elements[0] as HTMLInputElement, value) ? status('filled') : status('failed');
    case 'checkbox-group': {
      const wanted = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (wanted.length === 0) return status('empty');
      const boxes = target.elements as HTMLInputElement[];
      for (const w of wanted) {
        const box =
          boxes.find((b) => b.value.toLowerCase() === w.toLowerCase()) ??
          boxes.find((b) => (b.labels?.[0]?.textContent ?? '').trim().toLowerCase() === w.toLowerCase()) ??
          boxes.find((b) => b.value.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(b.value.toLowerCase()));
        if (box && !box.checked) {
          if (box.disabled) continue;
          box.click();
        }
      }
      return status('filled');
    }
    default:
      return status('failed');
  }
}

/**
 * Read-only check that a field already holds the intended value. Never touches
 * the DOM — safe to run after trusted-input retyping, where a second synthetic
 * write could clobber framework state that only accepted real keystrokes.
 */
export function verifyFill(target: FillTarget, rawValue: string): FillResult {
  const status = (s: FillStatus): FillResult => ({ fieldId: target.descriptor.id, status: s });
  if (!target.elements[0]) return status('not-found');
  if (isSensitive(target.descriptor)) return status('skipped-sensitive');
  const el = target.elements[0];
  switch (target.kind) {
    case 'checkbox': {
      const box = el as HTMLInputElement;
      if (truthy(rawValue) !== box.checked)
        return { fieldId: target.descriptor.id, status: 'failed', detail: 'checkbox does not reflect the approved state' };
      return status('filled');
    }
    case 'radio':
    case 'checkbox-group': {
      const wanted = target.kind === 'radio' ? [rawValue] : rawValue.split(',').map((s) => s.trim()).filter(Boolean);
      const boxes = target.elements as HTMLInputElement[];
      for (const w of wanted) {
        const box =
          boxes.find((b) => b.value.toLowerCase() === w.toLowerCase()) ??
          boxes.find((b) => (b.labels?.[0]?.textContent ?? '').trim().toLowerCase() === w.toLowerCase());
        if (!box) return { fieldId: target.descriptor.id, status: 'failed', detail: `no option matching "${w}"` };
        if (!box.checked) return { fieldId: target.descriptor.id, status: 'failed', detail: `"${w}" is not checked` };
      }
      return status('filled');
    }
    case 'select': {
      const sel = el as HTMLSelectElement;
      const nv = rawValue.trim().toLowerCase();
      const opt =
        Array.from(sel.options).find((o) => o.value.toLowerCase() === nv || o.text.trim().toLowerCase() === nv) ??
        Array.from(sel.options).find((o) => o.text.trim().toLowerCase().includes(nv) || nv.includes(o.text.trim().toLowerCase()));
      return opt && !opt.disabled && sel.value === opt.value ? status('filled') : status('failed');
    }
    default:
      // input / textarea — compare with the same mask tolerance as fill.
      return valuesMatch(el.value, rawValue.trim()) ? status('filled') : status('failed');
  }
}
