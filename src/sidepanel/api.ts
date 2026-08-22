import type { ContentRequest, DetectResponse, FillResult, Profile, StoredFile } from '../shared/types';
import { emptyProfile, emptySettings, ProfileSchema, SettingsSchema } from '../shared/schema';

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
  const parsed = SettingsSchema.safeParse(await storageGet<unknown>('settings'));
  return parsed.success ? parsed.data : emptySettings();
}

export async function saveSettings(settings: ReturnType<typeof emptySettings>): Promise<void> {
  await chrome.storage.local.set({ settings });
}

/** The user's resume file for auto-attach — stored separately from the profile (it's binary and big). */
export async function loadResumeFile(): Promise<StoredFile | null> {
  return (await storageGet<StoredFile>('resumeFile')) ?? null;
}

export async function saveResumeFile(file: StoredFile | null): Promise<void> {
  if (file) await chrome.storage.local.set({ resumeFile: file });
  else await chrome.storage.local.remove('resumeFile');
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
  values: { fieldId: string; value: string }[],
  resumeFile?: StoredFile,
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
        const r = await sendToFrame<{ results: FillResult[] }>(tabId, frameId, { type: 'AF_FILL', values: vals, resumeFile });
        results.push(...r.results.map((res) => ({ ...res, fieldId: `${prefix(frameId)}${res.fieldId}` })));
      } catch {
        results.push(...vals.map((v) => ({ fieldId: v.fieldId, status: 'not-found' as const })));
      }
    }),
  );

  // CDP refill: fields the page refused get retyped as REAL trusted keystrokes
  // via chrome.debugger — the only thing frameworks that filter synthetic
  // events (Phenom, some Google forms) will accept. Shows Chrome's debugging
  // banner for a moment; only runs for fields that failed the normal path.
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    const refilled = await cdpRefill(tabId, failed, values).catch(() => [] as FillResult[]);
    for (const r of refilled) {
      const i = results.findIndex((x) => x.fieldId === r.fieldId);
      if (i >= 0) results[i] = r;
    }
  }
  return { results };
}

/** Re-type failed fields as trusted input, then re-verify through the normal path. */
async function cdpRefill(
  tabId: number,
  failed: FillResult[],
  values: { fieldId: string; value: string }[],
): Promise<FillResult[]> {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, '1.3');
  try {
    for (const r of failed) {
      const [frameId, local] = split(r.fieldId);
      const v = values.find((x) => x.fieldId === r.fieldId)?.value;
      if (!v) continue;
      await sendToFrame(tabId, frameId, { type: 'AF_FOCUS', fieldId: local, clear: true });
      await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: v });
    }
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
  // Re-run the normal fill on just the failed fields — it re-verifies and
  // reports honest status now that the value arrived as trusted input.
  const redo = new Map<number, { fieldId: string; value: string }[]>();
  const out: FillResult[] = [];
  for (const r of failed) {
    const [frameId, local] = split(r.fieldId);
    const v = values.find((x) => x.fieldId === r.fieldId)!.value;
    const list = redo.get(frameId) ?? [];
    list.push({ fieldId: local, value: v });
    redo.set(frameId, list);
  }
  await Promise.all(
    [...redo].map(async ([frameId, vals]) => {
      try {
        const r = await sendToFrame<{ results: FillResult[] }>(tabId, frameId, { type: 'AF_FILL', values: vals });
        out.push(...r.results.map((res) => ({ ...res, fieldId: `${prefix(frameId)}${res.fieldId}` })));
      } catch {
        out.push(...vals.map((v) => ({ fieldId: v.fieldId, status: 'failed' as const })));
      }
    }),
  );
  return out;
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
