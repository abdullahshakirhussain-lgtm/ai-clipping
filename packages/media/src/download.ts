import { promises as fs } from "node:fs";
import { join } from "node:path";
import { probe, synthesizeTestVideo } from "./ffmpeg.js";

export interface DownloadResult {
  filePath: string;
  title: string;
  durationSec: number;
  width: number;
  height: number;
  metadata: Record<string, unknown>;
}

export interface DownloadProvider {
  download(url: string, destDir: string): Promise<DownloadResult>;
}

export interface YtDlpOptions {
  /** e.g. http://user:pass@host:port — route around datacenter-IP blocks. */
  proxy?: string;
  /** Path to a Netscape cookies.txt (e.g. exported YouTube cookies). */
  cookiesFile?: string;
}

/** Real downloads via yt-dlp (lazy-imported so mock mode never needs the binary). */
export class YtDlpDownloader implements DownloadProvider {
  constructor(private readonly opts: YtDlpOptions = {}) {}

  async download(url: string, destDir: string): Promise<DownloadResult> {
    await fs.mkdir(destDir, { recursive: true });
    const { default: ytdlp } = await import("youtube-dl-exec");
    const outTemplate = join(destDir, "source.%(ext)s");
    const ytdlpArgs: Record<string, unknown> = {
      output: outTemplate,
      // Always require a video stream (bv* = best *video*), plus audio; fall back
      // to any combined format. Height cap keeps files reasonable.
      format: "bv*[height<=1080]+ba/bv*+ba/b[height<=1080]/b",
      mergeOutputFormat: "mp4",
      printJson: true,
      noPlaylist: true,
    };
    // Optional: proxy (for YouTube/geo blocks) and cookies (for logged-in sites).
    if (this.opts.proxy) ytdlpArgs.proxy = this.opts.proxy;
    if (this.opts.cookiesFile) ytdlpArgs.cookies = this.opts.cookiesFile;
    const info = (await ytdlp(url, ytdlpArgs)) as unknown as Record<string, unknown>;

    // The merged output is `source.<ext>`; yt-dlp's per-stream intermediates are
    // `source.f<id>.<ext>` (e.g. an audio-only fragment). Match only the final
    // file (no `.f123.` segment) and prefer a video container.
    const files = await fs.readdir(destDir);
    const finals = files.filter((f) => /^source\.[^.]+$/.test(f));
    const order = ["mp4", "mkv", "webm", "mov"];
    const produced =
      finals.sort(
        (a, b) =>
          (order.indexOf(a.split(".").pop()!) + 1 || 99) -
          (order.indexOf(b.split(".").pop()!) + 1 || 99),
      )[0] ?? files.find((f) => f.startsWith("source."));
    if (!produced) {
      throw new Error("yt-dlp finished but produced no output file");
    }
    const filePath = join(destDir, produced);
    const probed = await probe(filePath);
    if (!probed.width || !probed.height) {
      throw new Error(
        "Downloaded source has no video stream (got audio only). Try a different source URL.",
      );
    }
    return {
      filePath,
      title: String(info.title ?? "Untitled"),
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      metadata: {
        uploader: info.uploader,
        webpage_url: info.webpage_url,
        ext: info.ext,
        fps: info.fps,
      },
    };
  }
}

/** Offline driver: synthesizes a real, playable test video with FFmpeg. */
export class MockDownloader implements DownloadProvider {
  constructor(private readonly durationSec = 180) {}

  async download(url: string, destDir: string): Promise<DownloadResult> {
    await fs.mkdir(destDir, { recursive: true });
    const filePath = join(destDir, "source.mp4");
    await synthesizeTestVideo(filePath, this.durationSec);
    const probed = await probe(filePath);
    return {
      filePath,
      title: `Mock video (${url.slice(0, 60)})`,
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      metadata: { driver: "mock", sourceUrl: url },
    };
  }
}
