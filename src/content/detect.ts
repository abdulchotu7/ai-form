import type { FieldDescriptor, FieldType } from '../shared/types';

/**
 * DOM form detection. Inspects the whole page (not just <form> elements)
 * and normalizes every fillable control into a FieldDescriptor.
 * Structured to accept a Document root so it is unit-testable.
 */

export interface FillTarget {
  kind: 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkbox-group';
  elements: (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
  descriptor: FieldDescriptor;
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  // checkVisibility exists in Chrome; absent in test environments → keep element.
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return true;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function humanize(s: string): string {
  return s.replace(/[_\-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

function inputType(input: HTMLInputElement): FieldType {
  const t = input.type;
  if (t === 'email' || t === 'tel' || t === 'number' || t === 'date' || t === 'password' || t === 'file') return t;
  if (SKIP_INPUT_TYPES.has(t)) return 'other';
  if (t === 'checkbox') return 'checkbox';
  if (t === 'radio') return 'radio';
  if (t === 'time' || t === 'month' || t === 'week') return 'text';
  return 'text';
}

/** Best-effort label resolution for a single control. */
export function resolveLabel(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, doc: Document): { label: string; context: string } {
  let label = '';

  if (el.id) {
    label = text(doc.querySelector(`label[for="${CSS.escape(el.id)}"]`));
  }
  if (!label) {
    const wrap = el.closest('label');
    if (wrap) {
      // Label text minus the input's own value/placeholder contribution.
      const clone = wrap.cloneNode(true) as Element;
      clone.querySelectorAll('input,textarea,select').forEach((n) => n.remove());
      label = text(clone);
    }
  }
  if (!label && el.getAttribute('aria-labelledby')) {
    const ids = el.getAttribute('aria-labelledby')!.split(/\s+/);
    label = ids.map((id) => text(doc.getElementById(id))).filter(Boolean).join(' ');
  }
  if (!label) label = el.getAttribute('aria-label')?.trim() ?? '';
  if (!label) label = el.getAttribute('placeholder')?.trim() ?? '';
  // Heuristic: table layouts — use row/cell headers as the label (before name attr,
  // which is usually a worse guess).
  if (!label) {
    const cell = el.closest('td');
    if (cell) {
      label =
        text(cell.querySelector('th')) ||
        text(cell.parentElement?.querySelector('th')) ||
        text(cell.previousElementSibling);
    }
  }
  if (!label) label = humanize(el.getAttribute('name') ?? '');

  // Surrounding semantic context: fieldset legend + aria-describedby.
  let context = '';
  const legend = el.closest('fieldset')?.querySelector('legend');
  if (legend) context = text(legend);
  if (el.getAttribute('aria-describedby')) {
    const desc = el
      .getAttribute('aria-describedby')!
      .split(/\s+/)
      .map((id) => text(doc.getElementById(id)))
      .filter(Boolean)
      .join(' ');
    if (desc) context = context ? `${context} — ${desc}` : desc;
  }

  // For radio/checkbox, the wrapping element's sibling text often holds the option label.
  return { label, context };
}

function optionLabel(el: HTMLInputElement): string {
  // Prefer an associated label for radios/checkboxes, else value, else nearby text.
  if (el.id) {
    const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) return text(l);
  }
  const wrap = el.closest('label');
  if (wrap) {
    const clone = wrap.cloneNode(true) as Element;
    clone.querySelectorAll('input').forEach((n) => n.remove());
    const t = text(clone);
    if (t) return t;
  }
  return el.value || text(el.parentElement);
}

interface ScanResult {
  fields: FieldDescriptor[];
  targets: Map<string, FillTarget>;
}

/**
 * Collect fillable controls including those inside open shadow roots
 * (Workday and other modern ATS render forms in web components).
 */
function collectControls(root: Document): Element[] {
  const out = [...root.querySelectorAll('input, textarea, select')];
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot) out.push(...el.shadowRoot.querySelectorAll('input, textarea, select'));
  }
  return out;
}

// Stable per-element ids: the same control keeps its id across rescans,
// so DOM mutations between Analyze and Fill cannot shift ids onto the
// wrong inputs. Module-level so every scan shares one id space.
const elementIds = new WeakMap<Element, string>();
let idCounter = 0;

export function scanForm(root: Document): ScanResult {
  const fields: FieldDescriptor[] = [];
  const targets = new Map<string, FillTarget>();

  const nextId = (keyEl: Element) => {
    let id = elementIds.get(keyEl);
    if (!id) {
      id = `f${idCounter++}`;
      elementIds.set(keyEl, id);
    }
    return id;
  };

  const controls = collectControls(root).filter((el) => {
    if (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) return false;
    if ((el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.disabled) return false;
    if (el instanceof HTMLInputElement && SKIP_INPUT_TYPES.has(el.type)) return false;
    return isVisible(el);
  });

  const consumed = new Set<Element>();

  for (const el of controls) {
    if (consumed.has(el)) continue;

    /* ---- radio groups ---- */
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const group = controls.filter(
        (c): c is HTMLInputElement => c instanceof HTMLInputElement && c.type === 'radio' && c.name !== '' && c.name === el.name,
      );
      group.forEach((g) => consumed.add(g));
      const first = group[0];
      const { label, context } = resolveLabel(first, root);
      const options = [...new Set(group.map((g) => optionLabel(g) || g.value).filter(Boolean))];
      const id = nextId(first);
      fields.push({
        id,
        type: 'radio',
        label,
        placeholder: '',
        required: group.some((g) => g.required),
        options,
        context,
        name: first.name,
      });
      targets.set(id, { kind: 'radio', elements: group, descriptor: fields[fields.length - 1] });
      continue;
    }

    /* ---- checkbox groups (2+ checkboxes sharing a name) ---- */
    if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.name) {
      const group = controls.filter(
        (c): c is HTMLInputElement => c instanceof HTMLInputElement && c.type === 'checkbox' && c.name === el.name,
      );
      if (group.length > 1) {
        group.forEach((g) => consumed.add(g));
        const { label, context } = resolveLabel(group[0], root);
        const options = [...new Set(group.map((g) => optionLabel(g) || g.value).filter(Boolean))];
        const id = nextId(group[0]);
        fields.push({
          id,
          type: 'checkbox-group',
          label,
          placeholder: '',
          required: group.some((g) => g.required),
          options,
          context,
          name: group[0].name,
        });
        targets.set(id, { kind: 'checkbox-group', elements: group, descriptor: fields[fields.length - 1] });
        continue;
      }
      // single named checkbox falls through to generic handling below
    }

    /* ---- single controls ---- */
    let kind: FillTarget['kind'];
    let type: FieldType;
    let options: string[] = [];

    if (el instanceof HTMLTextAreaElement) {
      kind = 'textarea';
      type = 'textarea';
    } else if (el instanceof HTMLSelectElement) {
      kind = 'select';
      type = 'select';
      options = Array.from(el.options)
        .map((o) => o.text.trim())
        .filter((t) => t && !/^(-+|select|choose|please select|-- )/i.test(t));
    } else if (el instanceof HTMLInputElement) {
      type = inputType(el);
      kind = el.type === 'checkbox' ? 'checkbox' : 'input';
    } else {
      continue;
    }

    const { label, context } = resolveLabel(el, root);
    const id = nextId(el);
    fields.push({
      id,
      type,
      label,
      placeholder: el.getAttribute('placeholder') ?? '',
      required: el.required || el.getAttribute('aria-required') === 'true',
      options,
      context,
      name: el.getAttribute('name') ?? '',
    });
    targets.set(id, { kind, elements: [el], descriptor: fields[fields.length - 1] });
  }

  return { fields, targets };
}
