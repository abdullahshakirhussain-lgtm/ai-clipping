/**
 * Shared message contracts for the three hops:
 *   dashboard page  <-- window.postMessage -->  bridge content script
 *   bridge          <-- chrome.runtime      -->  background service worker
 *   background      <-- chrome.tabs/runtime -->  platform content script
 *
 * Kept dependency-free so it bundles into every entry point.
 */

export const PAGE_SOURCE = "clipfactory-dashboard" as const;
export const EXT_SOURCE = "clipfactory-ext" as const;

/** A single post handed from the dashboard queue to the extension. */
export interface PostJob {
  jobId: string;
  platform: "YOUTUBE" | "TIKTOK" | "FACEBOOK";
  /** Presigned clip URL (R2) the extension downloads for the upload. */
  downloadUrl: string;
  filename: string;
  title: string;
  description: string;
  hashtags: string[];
  /** Optional target channel/page id to switch to before uploading. */
  channelId?: string | null;
}

// ── page -> bridge (window.postMessage) ────────────────────────────────────
export type PageMessage =
  | { source: typeof PAGE_SOURCE; kind: "ping" }
  | { source: typeof PAGE_SOURCE; kind: "postJob"; job: PostJob };

// ── bridge -> page (window.postMessage) ────────────────────────────────────
export type ExtMessage =
  | { source: typeof EXT_SOURCE; kind: "hello" }
  | { source: typeof EXT_SOURCE; kind: "pong" }
  | { source: typeof EXT_SOURCE; kind: "status"; jobId: string; message: string }
  | { source: typeof EXT_SOURCE; kind: "result"; jobId: string; url?: string; error?: string };

// ── bridge/content <-> background (chrome.runtime) ─────────────────────────
export type RuntimeMessage =
  | { type: "postJob"; job: PostJob }
  | { type: "getJob" }
  | { type: "status"; jobId: string; message: string }
  | { type: "result"; jobId: string; url?: string; error?: string };

export function buildCaption(job: Pick<PostJob, "title" | "description" | "hashtags">): string {
  return [job.title, job.description, job.hashtags.join(" ")].filter(Boolean).join("\n\n");
}
