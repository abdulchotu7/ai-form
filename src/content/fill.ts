import type { FillResult, FillStatus } from '../shared/types';
import type { FillTarget } from './detect';
import { isSensitive } from '../shared/match';

/**
 * Deterministic DOM filling. Only explicitly implemented operations —
 * set value / check control / select option. Never clicks buttons,
 * never navigates, never submits.
 */

/** Set value through the native prototype setter so React/Vue/Angular notice. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
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
  const d = new Date(v);
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
  else if (!box.checked && want) box.click();
  return true;
}

export function applyFill(target: FillTarget, rawValue: string): FillResult {
  const status = (s: FillStatus): FillResult => ({ fieldId: target.descriptor.id, status: s });

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
      return el.value === v ? status('filled') : status('failed');
    }
    case 'textarea': {
      const el = target.elements[0] as HTMLTextAreaElement;
      if (el.disabled) return status('failed');
      setNativeValue(el, value);
      return status('filled');
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
