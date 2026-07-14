/**
 * Runs on the YouTube Studio upload page. For an assisted post (X1) it:
 *   - fills the title + description once the metadata dialog appears (after the
 *     user picks the downloaded clip), and
 *   - watches for the published video URL and reports it back.
 * The user still picks the file and clicks Next/Publish; X2 automates those.
 *
 * NOTE: these selectors track YouTube Studio's DOM, which changes without
 * notice. Each is written with fallbacks; when uploads stop auto-filling, this
 * is the first place to update.
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

/** Title/description are contenteditable divs inside labelled containers. */
function titleBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea #textbox");
}
function descBox(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#description-textarea #textbox, ytcp-social-suggestions-textbox#description-textarea #textbox");
}

function setEditable(el: HTMLElement, text: string): void {
  el.focus();
  const sel = window.getSelection();
  if (sel) {
    sel.selectAllChildren(el);
    // execCommand is deprecated but remains the reliable way to write into a
    // contenteditable and fire the framework's own input handlers.
    const ok = document.execCommand("insertText", false, text);
    if (ok) return;
  }
  el.textContent = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

const URL_RE = /https?:\/\/(?:youtu\.be\/[\w-]+|(?:www\.)?youtube\.com\/(?:watch\?v=|shorts\/)[\w-]+)/;

function findPublishedUrl(): string | null {
  // The post-publish dialog surfaces the link as an anchor and/or an input.
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='youtu']"))) {
    const m = URL_RE.exec(a.href) ?? URL_RE.exec(a.textContent ?? "");
    if (m) return m[0];
  }
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input[value*='youtu']"))) {
    const m = URL_RE.exec(input.value);
    if (m) return m[0];
  }
  return null;
}

async function watchForPublish(jobId: string): Promise<void> {
  // Poll for up to 30 min — large clips + processing can take a while.
  const found = await waitFor(findPublishedUrl, 30 * 60 * 1000);
  if (found) send({ type: "result", jobId, url: found });
  else send({ type: "result", jobId, error: "timed out waiting for the published URL" });
}

async function run(job: PostJob): Promise<void> {
  status(job.jobId, "Waiting for the upload dialog…");
  const title = await waitFor(titleBox, 5 * 60 * 1000); // user has to pick the file first
  if (!title) {
    send({ type: "result", jobId: job.jobId, error: "upload dialog didn't appear (did you pick the file?)" });
    return;
  }

  const caption = buildCaption(job);
  setEditable(title, job.title.slice(0, 100)); // YT title cap
  await sleep(300);
  const desc = descBox();
  if (desc) setEditable(desc, caption);
  status(job.jobId, "Title + description filled. Click Next → Publish; I'll grab the link.");

  void watchForPublish(job.jobId);
}

// Ask the background worker whether this tab was opened for a job.
chrome.runtime.sendMessage({ type: "getJob" } satisfies RuntimeMessage).then((job: PostJob | null) => {
  if (job) void run(job);
}).catch(() => {});
