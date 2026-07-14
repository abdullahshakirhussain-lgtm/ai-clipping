/**
 * Runs on TikTok's upload page (tiktokstudio/upload). Once the user picks the
 * downloaded clip, it fills the caption and clicks Post, then tries to capture
 * the posted video URL. TikTok rarely surfaces the direct URL right away, so if
 * we can't grab it the job is left for the user to mark manually (the status
 * says so) — the post itself still goes out.
 *
 * NOTE: TikTok's uploader DOM changes often and is React/DraftJS-based; these
 * selectors are the first thing to update if caption-fill or Post stops working.
 */
import { buildCaption, type PostJob, type RuntimeMessage } from "./protocol.js";

function send(msg: RuntimeMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
function status(jobId: string, message: string): void {
  send({ type: "status", jobId, message });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(find: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = find();
    if (el) return el;
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

/** DraftJS caption editor. */
function captionBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '.public-DraftEditor-content[contenteditable="true"], div[data-contents="true"] [contenteditable="true"], div[contenteditable="true"][role="textbox"]',
  );
}

function setEditable(el: HTMLElement, text: string): void {
  el.focus();
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(el);
    if (document.execCommand("insertText", false, text)) return;
  }
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

/** The Post button — data-e2e on the classic uploader, text match in Studio. */
function postButton(): HTMLButtonElement | null {
  const byE2e = document.querySelector<HTMLButtonElement>('button[data-e2e="post_video_button"]');
  if (byE2e) return byE2e;
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
    if (b.textContent?.trim().toLowerCase() === "post" && !b.disabled) return b;
  }
  return null;
}

const URL_RE = /https?:\/\/(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+/;
function findPostedUrl(): string | null {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/video/']"))) {
    const m = URL_RE.exec(a.href);
    if (m) return m[0];
  }
  const m = URL_RE.exec(location.href);
  return m ? m[0] : null;
}

async function run(job: PostJob): Promise<void> {
  status(job.jobId, "Waiting for TikTok's editor…");
  const box = await waitFor(captionBox, 5 * 60 * 1000); // user picks the file first
  if (!box) {
    send({ type: "result", jobId: job.jobId, error: "caption editor didn't appear (did you pick the file?)" });
    return;
  }

  setEditable(box, buildCaption(job));
  status(job.jobId, "Caption filled. Posting when TikTok finishes processing…");

  // Wait for Post to become enabled (upload must finish), then click.
  const post = await waitFor(postButton, 30 * 60 * 1000);
  if (post) {
    post.click();
    status(job.jobId, "Posting…");
  } else {
    status(job.jobId, "Couldn't find the Post button — post manually; I'll grab the link if it appears.");
  }

  const url = await waitFor(findPostedUrl, 10 * 60 * 1000);
  if (url) send({ type: "result", jobId: job.jobId, url });
  else send({ type: "result", jobId: job.jobId, error: "posted, but couldn't capture the URL — paste it to mark done" });
}

chrome.runtime.sendMessage({ type: "getJob" } satisfies RuntimeMessage).then((job: PostJob | null) => {
  if (job) void run(job);
}).catch(() => {});
