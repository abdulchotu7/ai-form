// Opens the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error('sidePanel setup failed', e));

/**
 * Frame registry. Content scripts run in every frame (all_frames: true) and
 * check in here on load, so the side panel can address each frame of a tab
 * individually — ATS application forms often live in an iframe while the top
 * frame has no fields at all.
 */
const frameIdsByTab = new Map<number, Set<number>>();

chrome.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }, sender, sendResponse) => {
  if (msg?.type === 'AF_FRAME_HELLO' && sender.tab?.id != null && sender.frameId != null && sender.frameId > 0) {
    const set = frameIdsByTab.get(sender.tab.id) ?? new Set<number>();
    set.add(sender.frameId);
    frameIdsByTab.set(sender.tab.id, set);
    sendResponse(true);
  }
  if (msg?.type === 'AF_FRAMES' && typeof msg.tabId === 'number') {
    sendResponse([...(frameIdsByTab.get(msg.tabId) ?? [])]);
  }
  return false;
});

function forgetTab(tabId: number) {
  frameIdsByTab.delete(tabId);
}
chrome.tabs.onRemoved.addListener(forgetTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Fresh navigation → old frames are gone; they re-register from scratch.
  if (changeInfo.status === 'loading') forgetTab(tabId);
});
