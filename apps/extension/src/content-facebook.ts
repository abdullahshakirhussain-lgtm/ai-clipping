/**
 * Runs on Meta Business Suite (business.facebook.com). Once the user picks the
 * downloaded clip in the composer, it fills the post text and tries to click
 * Publish, then watches for the resulting post/reel URL.
 *
 * Facebook is the least predictable of the three targets: Business Suite's DOM is
 * heavily obfuscated (generated class names), so this leans on role/aria/text
 * selectors and is very much best-effort. If it can't drive the composer, the
 * user finishes by hand and pastes the URL. Make sure the correct Page is
 * selected in Business Suite before posting.
 *
 * NOTE: first place to update when Facebook posting stops working.
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
    await sleep(500);
  }
}

/** The composer's post-text box (contenteditable rich-text area). */
function composerBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'div[role="textbox"][contenteditable="true"], div[contenteditable="true"][aria-label*="post" i], div[contenteditable="true"][aria-label*="mind" i]',
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

/** A clickable "Publish" control (button or aria-labelled div), if enabled. */
function publishButton(): HTMLElement | null {
  const byAria = document.querySelector<HTMLElement>(
    'div[aria-label="Publish"][role="button"], button[aria-label="Publish"]',
  );
  if (byAria && byAria.getAttribute("aria-disabled") !== "true") return byAria;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('div[role="button"], button'))) {
    if (b.textContent?.trim() === "Publish" && b.getAttribute("aria-disabled") !== "true") return b;
  }
  return null;
}

const URL_RE =
  /https?:\/\/(?:www\.|business\.)?facebook\.com\/[\w.-]+\/(?:posts|videos|reel)\/[\w-]+/;
function findPostedUrl(): string | null {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='facebook.com/']"))) {
    const m = URL_RE.exec(a.href);
    if (m) return m[0];
  }
  return null;
}

async function run(job: PostJob): Promise<void> {
  status(job.jobId, "Waiting for the Facebook composer…");
  const box = await waitFor(composerBox, 5 * 60 * 1000); // user picks the file first
  if (!box) {
    send({ type: "result", jobId: job.jobId, error: "composer didn't appear (open a post composer and pick the file?)" });
    return;
  }

  setEditable(box, buildCaption(job));
  status(job.jobId, "Caption filled. Confirm the Page, then publishing…");

  const publish = await waitFor(publishButton, 30 * 60 * 1000);
  if (publish) {
    publish.click();
    status(job.jobId, "Publishing…");
  } else {
    status(job.jobId, "Couldn't find Publish — post manually; I'll grab the link if it appears.");
  }

  const url = await waitFor(findPostedUrl, 10 * 60 * 1000);
  if (url) send({ type: "result", jobId: job.jobId, url });
  else send({ type: "result", jobId: job.jobId, error: "posted, but couldn't capture the URL — paste it to mark done" });
}

chrome.runtime.sendMessage({ type: "getJob" } satisfies RuntimeMessage).then((job: PostJob | null) => {
  if (job) void run(job);
}).catch(() => {});
