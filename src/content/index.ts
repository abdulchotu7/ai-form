import type { ContentRequest, DetectResponse } from '../shared/types';
import { scanForm } from './detect';
import { applyFill } from './fill';

// Load marker (isolated world — invisible to the page). Guards against double
// registration if the script gets injected twice (programmatic fallback path).
if (document.documentElement.dataset.afFormAssistant !== '1') {
  document.documentElement.dataset.afFormAssistant = '1';

  // Register this frame with the background frame registry so the side panel
  // can address this frame individually.
  void chrome.runtime.sendMessage({ type: 'AF_FRAME_HELLO' }).catch(() => {});

  let lastDomVersion = 0;
  const bump = (() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (timer) return; // debounce bursts of mutations
      timer = setTimeout(() => {
        timer = null;
        lastDomVersion++;
      }, 1000);
    };
  })();

  // Watch for dynamically added/removed fields. Cheap: only bumps a counter,
  // the side panel decides when to rescan (never rescans on a timer).
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
        const relevant = [...m.addedNodes, ...m.removedNodes].some(
          (n) => n instanceof Element && n.querySelector('input, textarea, select'),
        );
        if (relevant) {
          bump();
          break;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((req: ContentRequest, _sender, sendResponse) => {
    if (req?.type === 'AF_DETECT') {
      // Always scan live DOM — analysis is on-demand, never periodic.
      const { fields } = scanForm(document);
      const res: DetectResponse = { fields, domVersion: lastDomVersion };
      sendResponse(res);
      return false;
    }
    if (req?.type === 'AF_FILL') {
      // Field ids are stable per element (see detect.ts), so a fresh scan
      // resolves the same ids even if the DOM shifted since analysis.
      const targets = scanForm(document).targets;
      const results = req.values.map(({ fieldId, value }) => {
        const target = targets.get(fieldId);
        if (!target) return { fieldId, status: 'not-found' as const };
        return applyFill(target, value);
      });
      sendResponse({ results });
      return false;
    }
    return undefined;
  });
}

export {};
