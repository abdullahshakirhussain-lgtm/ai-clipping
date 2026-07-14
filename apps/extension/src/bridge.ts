/**
 * Content script injected on the ClipFactory dashboard origin. It is the only
 * link between the web page (which holds the API session) and the extension:
 * the page speaks window.postMessage; this relays to/from the background worker.
 * The page never needs the extension ID or any chrome API.
 */
import { EXT_SOURCE, PAGE_SOURCE, type ExtMessage, type PageMessage, type RuntimeMessage } from "./protocol.js";

function toPage(msg: ExtMessage): void {
  window.postMessage(msg, window.location.origin);
}

// Announce presence so the dashboard can flip its "connected" indicator without
// polling. Also re-announce on SPA route changes are unnecessary — the page
// listens continuously and can ping any time.
toPage({ source: EXT_SOURCE, kind: "hello" });

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as PageMessage | undefined;
  if (!data || data.source !== PAGE_SOURCE) return;

  if (data.kind === "ping") {
    toPage({ source: EXT_SOURCE, kind: "pong" });
    return;
  }
  if (data.kind === "postJob") {
    const msg: RuntimeMessage = { type: "postJob", job: data.job };
    chrome.runtime.sendMessage(msg).catch((err) => {
      toPage({ source: EXT_SOURCE, kind: "result", jobId: data.job.jobId, error: String(err) });
    });
  }
});

// Background relays progress/results for this dashboard tab back to the page.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === "status") {
    toPage({ source: EXT_SOURCE, kind: "status", jobId: msg.jobId, message: msg.message });
  } else if (msg.type === "result") {
    toPage({ source: EXT_SOURCE, kind: "result", jobId: msg.jobId, url: msg.url, error: msg.error });
  }
});
