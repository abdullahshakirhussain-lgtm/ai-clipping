"use client";
import { useEffect, useState } from "react";

/**
 * Thin wrapper around the ClipFactory Poster extension. Communication is pure
 * window.postMessage — the page needs no chrome APIs and no extension ID. The
 * extension's content script (bridge.js) relays to/from the background worker.
 */

const PAGE_SOURCE = "clipfactory-dashboard";
const EXT_SOURCE = "clipfactory-ext";

export interface PostJob {
  jobId: string;
  platform: "YOUTUBE" | "TIKTOK" | "FACEBOOK";
  downloadUrl: string;
  filename: string;
  title: string;
  description: string;
  hashtags: string[];
  channelId?: string | null;
}

export interface ExtIncoming {
  source: typeof EXT_SOURCE;
  kind: "hello" | "pong" | "status" | "result";
  jobId?: string;
  url?: string;
  error?: string;
  message?: string;
}

/** Subscribe to messages coming from the extension. Returns an unsubscribe fn. */
export function subscribe(cb: (m: ExtIncoming) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data as ExtIncoming | undefined;
    if (!d || d.source !== EXT_SOURCE) return;
    cb(d);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

function ping(): void {
  window.postMessage({ source: PAGE_SOURCE, kind: "ping" }, window.location.origin);
}

export function sendJob(job: PostJob): void {
  window.postMessage({ source: PAGE_SOURCE, kind: "postJob", job }, window.location.origin);
}

/** True once the extension has answered a ping (or announced itself). */
export function useExtensionConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const unsub = subscribe((m) => {
      if (m.kind === "hello" || m.kind === "pong") setConnected(true);
    });
    ping();
    const iv = setInterval(ping, 3000);
    return () => {
      unsub();
      clearInterval(iv);
    };
  }, []);
  return connected;
}
