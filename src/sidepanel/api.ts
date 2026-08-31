import type { ContentRequest, DetectResponse, FillResult, Profile } from '../shared/types';
import { emptyProfile, emptySettings, ProfileSchema } from '../shared/schema';
import { migrateSettings } from '../shared/providers';

/** chrome.* wrappers — the only place the side panel touches extension APIs. */

async function storageGet<T>(key: string): Promise<T | undefined> {
  const res = await chrome.storage.local.get(key);
  return res[key] as T | undefined;
}

export async function loadProfile(): Promise<Profile> {
  const raw = await storageGet<unknown>('profile');
  const parsed = ProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyProfile();
}

export async function saveProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ profile });
}

export async function loadSettings() {
  // migrateSettings handles legacy `{ llmBaseUrl, llmApiKey, llmModel }` storage
  // (infer Provider / fall back to Custom) plus VITE_<PROVIDER>_API_KEY seeding.
  return migrateSettings(await storageGet<unknown>('settings'));
}

export async function saveSettings(settings: ReturnType<typeof emptySettings>): Promise<void> {
  await chrome.storage.local.set({ settings });
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab;
}

/** Frame ids of a tab, from the background registry (content scripts check in on load). */
async function tabFrames(tabId: number): Promise<number[]> {
  try {
    const frames = await chrome.runtime.sendMessage({ type: 'AF_FRAMES', tabId });
    return Array.isArray(frames) ? frames : [];
  } catch {
    return [];
  }
}

/**
 * Active tab + the frames worth talking to. Content scripts run in every
 * frame (all_frames), so ATS forms embedded in an iframe are covered.
 */
async function activeTabWithFrames(): Promise<{ tabId: number; frames: number[] }> {
  const tab = await activeTab();
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('This page cannot be analyzed. Open a normal http(s) page.');
  }
  let frames = await tabFrames(tab.id!);
  if (frames.length === 0) {
    // Page opened before the extension loaded — inject into every frame.
    await chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, files: ['content.js'] });
    frames = await tabFrames(tab.id!);
    if (frames.length === 0) frames = [0]; // registry race fallback: top frame
  }
  // Top frame is always included; registered sub-frames come first.
  return { tabId: tab.id!, frames: [...new Set([0, ...frames])] };
}

/** Field ids are namespaced per frame so ids from different frames can't collide. */
const prefix = (frameId: number) => `g${frameId}:`;
const split = (prefixed: string): [number, string] => {
  const m = prefixed.match(/^g(\d+):(.*)$/);
  return m ? [Number(m[1]), m[2]] : [0, prefixed];
};

function sendToFrame<T>(tabId: number, frameId: number, msg: ContentRequest): Promise<T> {
  return chrome.tabs.sendMessage(tabId, msg, { frameId }) as Promise<T>;
}

export async function detectFields(): Promise<DetectResponse> {
  const { tabId, frames } = await activeTabWithFrames();
  const responses = await Promise.all(
    frames.map(async (frameId) => {
      try {
        return { frameId, res: await sendToFrame<DetectResponse>(tabId, frameId, { type: 'AF_DETECT' }) };
      } catch {
        return null; // frame without content script / not analyzable — skip
      }
    }),
  );
  const fields = [];
  let domVersion = 0;
  let pageContext = { title: '', description: '' };
  for (const r of responses) {
    if (!r) continue;
    domVersion = Math.max(domVersion, r.res.domVersion);
    if (r.res.pageContext?.title || r.res.pageContext?.description) pageContext = r.res.pageContext;
    for (const f of r.res.fields) fields.push({ ...f, id: `${prefix(r.frameId)}${f.id}` });
  }
  return { fields, domVersion, pageContext };
}

export async function fillFields(
  values: { fieldId: string; value: string; kind?: string }[],
): Promise<{ results: FillResult[] }> {
  const { tabId, frames } = await activeTabWithFrames();
  const byFrame = new Map<number, { fieldId: string; value: string }[]>();
  for (const v of values) {
    const [frameId, local] = split(v.fieldId);
    const list = byFrame.get(frameId) ?? [];
    list.push({ fieldId: local, value: v.value });
    byFrame.set(frameId, list);
  }

  const results: FillResult[] = [];
  await Promise.all(
    [...byFrame].map(async ([frameId, vals]) => {
      if (!frames.includes(frameId)) {
        results.push(...vals.map((v) => ({ fieldId: v.fieldId, status: 'not-found' as const })));
        return;
      }
      try {
        const r = await sendToFrame<{ results: FillResult[] }>(tabId, frameId, { type: 'AF_FILL', values: vals });
        results.push(...r.results.map((res) => ({ ...res, fieldId: `${prefix(frameId)}${res.fieldId}` })));
      } catch {
        results.push(...vals.map((v) => ({ fieldId: v.fieldId, status: 'not-found' as const })));
      }
    }),
  );
  return { results };
}

export async function currentPageInfo(): Promise<{ host: string; isAnalyzable: boolean }> {
  try {
    const tab = await activeTab();
    const url = tab.url ?? '';
    let host = '';
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    return { host, isAnalyzable: /^https?:/i.test(url) };
  } catch {
    return { host: '', isAnalyzable: false };
  }
}
