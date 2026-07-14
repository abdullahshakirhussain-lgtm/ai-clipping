/**
 * Runs on the YouTube Studio upload page. Once the user picks the downloaded
 * clip, this drives the whole upload wizard (X2):
 *   fill title + description → "not made for kids" → advance the steps →
 *   set Public → Publish → capture the published URL → report back.
 * The only manual step is picking the file (browsers forbid scripting a file
 * input). Wizard automation is best-effort and non-fatal: if any selector has
 * drifted, the user can finish by hand and the URL watcher still reports it.
 *
 * NOTE: every selector below tracks YouTube Studio's DOM, which changes without
 * notice. When automation stalls, this is the file to update.
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

const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
function click(el: Element | null): boolean {
  if (!el) return false;
  (el as HTMLElement).click();
  return true;
}

/** Title/description are contenteditable divs inside labelled containers. */
function titleBox(): HTMLElement | null {
  return q<HTMLElement>("#title-textarea #textbox, ytcp-social-suggestions-textbox#title-textarea #textbox");
}
function descBox(): HTMLElement | null {
  return q<HTMLElement>("#description-textarea #textbox, ytcp-social-suggestions-textbox#description-textarea #textbox");
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
  // Poll up to 30 min — large clips + processing can take a while.
  const found = await waitFor(findPublishedUrl, 30 * 60 * 1000);
  if (found) send({ type: "result", jobId, url: found });
  else send({ type: "result", jobId, error: "timed out waiting for the published URL" });
}

const VISIBILITY_PUBLIC = 'tp-yt-paper-radio-button[name="PUBLIC"]';

/** Is the wizard on the final Visibility step (Public/Unlisted/Private radios)? */
function onVisibilityStep(): boolean {
  return !!q(VISIBILITY_PUBLIC);
}

/** Drive Details → … → Visibility → Publish. Throws with the step that failed. */
async function autoPublish(jobId: string): Promise<void> {
  // "No, it's not made for kids" — required before the wizard will advance.
  const notForKids = await waitFor(
    () => q('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'),
    20000,
  );
  if (notForKids) click(notForKids);
  await sleep(400);

  // Advance to the Visibility step (Next appears on Details/Elements/Checks).
  for (let i = 0; i < 5 && !onVisibilityStep(); i++) {
    if (!click(q("#next-button"))) break;
    await sleep(1200);
  }
  if (!onVisibilityStep()) throw new Error("couldn't reach the visibility step");

  status(jobId, "Setting visibility to Public…");
  click(await waitFor(() => q(VISIBILITY_PUBLIC), 15000));
  await sleep(600);

  // Publish. #done-button is aria-disabled until required fields are set (it can
  // be clicked before processing finishes — YouTube publishes when ready).
  const done = await waitFor(() => {
    const b = q("#done-button");
    if (!b) return null;
    return b.getAttribute("aria-disabled") === "true" ? null : b;
  }, 30 * 60 * 1000);
  if (!done) throw new Error("publish button never enabled");
  click(done);
  status(jobId, "Publishing…");
}

/** Best-effort read of the signed-in channel name, so the user can confirm the
 *  upload is going to the right account. */
function activeChannelName(): string | null {
  const el = q("#account-name, ytcp-account-section #account-name, #entity-name");
  const name = el?.textContent?.trim();
  return name && name.length > 0 ? name : null;
}

async function run(job: PostJob): Promise<void> {
  const chan = activeChannelName();
  if (chan) status(job.jobId, `Uploading as: ${chan}`);
  status(job.jobId, "Waiting for the upload dialog…");
  const title = await waitFor(titleBox, 5 * 60 * 1000); // user picks the file first
  if (!title) {
    send({ type: "result", jobId: job.jobId, error: "upload dialog didn't appear (did you pick the file?)" });
    return;
  }

  const caption = buildCaption(job);
  setEditable(title, job.title.slice(0, 100)); // YT title cap
  await sleep(300);
  const desc = descBox();
  if (desc) setEditable(desc, caption);
  status(job.jobId, "Filled title + description. Automating the rest…");

  // Always watch for the URL — covers both auto-publish and a manual finish.
  void watchForPublish(job.jobId);

  // Wizard automation is non-fatal: on any drift, hand back to the user.
  try {
    await autoPublish(job.jobId);
  } catch (err) {
    status(job.jobId, `Couldn't auto-finish (${err instanceof Error ? err.message : String(err)}). Finish in YouTube — I'll still grab the link.`);
  }
}

// Ask the background worker whether this tab was opened for a job.
chrome.runtime.sendMessage({ type: "getJob" } satisfies RuntimeMessage).then((job: PostJob | null) => {
  if (job) void run(job);
}).catch(() => {});
