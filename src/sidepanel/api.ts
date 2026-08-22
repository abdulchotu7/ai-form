import type { ContentRequest, DetectResponse, FillResult, Profile } from '../shared/types';
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

async function activeTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return tab;
}

/** Message the active tab's content script; inject it first if missing (e.g. page opened before install). */
async function sendToTab<T>(msg: ContentRequest): Promise<T> {
  const tab = await activeTab();
  try {
    return await chrome.tabs.sendMessage(tab.id!, msg);
  } catch {
    if (!tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error('This page cannot be analyzed. Open a normal http(s) page.');
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tab.id!, msg);
  }
}

export async function detectFields(): Promise<DetectResponse> {
  return sendToTab<DetectResponse>({ type: 'AF_DETECT' });
}

export async function fillFields(values: { fieldId: string; value: string }[]): Promise<{ results: FillResult[] }> {
  return sendToTab<{ results: FillResult[] }>({ type: 'AF_FILL', values });
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
