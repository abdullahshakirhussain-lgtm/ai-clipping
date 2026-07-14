/**
 * Service worker. Orchestrates one post:
 *   1. bridge sends {postJob} (from the dashboard tab)
 *   2. download the clip, open the YouTube upload tab, remember the job for that tab
 *   3. the YouTube content script asks {getJob}; we hand it the job
 *   4. it reports {status}/{result}; we relay back to the originating dashboard tab
 *
 * Job state lives in chrome.storage.session (survives worker restarts within the
 * browser session), keyed by the upload tab id.
 */
import type { PostJob, RuntimeMessage } from "./protocol.js";

interface StoredJob {
  job: PostJob;
  dashTabId: number;
}

const key = (tabId: number): string => `job_${tabId}`;

/** Where to open the upload UI for each platform (channel-targeted for YouTube). */
function uploadUrl(job: PostJob): string | null {
  switch (job.platform) {
    case "YOUTUBE":
      return job.channelId
        ? `https://studio.youtube.com/channel/${encodeURIComponent(job.channelId)}/videos/upload?d=ud`
        : "https://www.youtube.com/upload";
    case "TIKTOK":
      return "https://www.tiktok.com/tiktokstudio/upload";
    default:
      return null; // FACEBOOK (X5) not wired yet
  }
}

async function startPost(job: PostJob, dashTabId: number): Promise<void> {
  const url = uploadUrl(job);
  if (!url) {
    relay(dashTabId, { type: "result", jobId: job.jobId, error: `${job.platform} posting isn't wired up yet` });
    return;
  }

  // Kick the download so the file is waiting in Downloads for the user to pick.
  try {
    await chrome.downloads.download({ url: job.downloadUrl, filename: job.filename });
  } catch (err) {
    relay(dashTabId, { type: "result", jobId: job.jobId, error: `download failed: ${String(err)}` });
    return;
  }

  const tab = await chrome.tabs.create({ url });
  if (tab.id == null) {
    relay(dashTabId, { type: "result", jobId: job.jobId, error: "could not open upload tab" });
    return;
  }
  await chrome.storage.session.set({ [key(tab.id)]: { job, dashTabId } satisfies StoredJob });
  const where = job.platform === "TIKTOK" ? "TikTok" : "YouTube";
  relay(dashTabId, { type: "status", jobId: job.jobId, message: `Opened ${where} — pick the downloaded clip to start.` });
}

function relay(dashTabId: number, msg: RuntimeMessage): void {
  if (msg.type === "status") void chrome.storage.session.set({ lastStatus: msg.message });
  else if (msg.type === "result") {
    void chrome.storage.session.set({ lastStatus: msg.error ? `Error: ${msg.error}` : `Posted: ${msg.url}` });
  }
  chrome.tabs.sendMessage(dashTabId, msg).catch(() => {
    /* dashboard tab may have navigated away; nothing to do */
  });
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = raw as RuntimeMessage;

  if (msg.type === "postJob") {
    const dashTabId = sender.tab?.id;
    if (dashTabId == null) return;
    void startPost(msg.job, dashTabId);
    return;
  }

  if (msg.type === "getJob") {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse(null);
      return true;
    }
    void chrome.storage.session.get(key(tabId)).then((store) => {
      sendResponse((store[key(tabId)] as StoredJob | undefined)?.job ?? null);
    });
    return true; // async sendResponse
  }

  if (msg.type === "status" || msg.type === "result") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    void chrome.storage.session.get(key(tabId)).then((store) => {
      const stored = store[key(tabId)] as StoredJob | undefined;
      if (!stored) return;
      relay(stored.dashTabId, msg);
      if (msg.type === "result") void chrome.storage.session.remove(key(tabId));
    });
    return;
  }
});
