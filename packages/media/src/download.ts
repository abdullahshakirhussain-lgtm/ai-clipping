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

/** Real downloads via yt-dlp (lazy-imported so mock mode never needs the binary). */
export class YtDlpDownloader implements DownloadProvider {
  async download(url: string, destDir: string): Promise<DownloadResult> {
    await fs.mkdir(destDir, { recursive: true });
    const { default: ytdlp } = await import("youtube-dl-exec");
    const outTemplate = join(destDir, "source.%(ext)s");
    const info = (await ytdlp(url, {
      output: outTemplate,
      // Prefer <=1080p mp4, but fall back to the best available in any container.
      format: "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
      mergeOutputFormat: "mp4",
      remuxVideo: "mp4",
      printJson: true,
      noPlaylist: true,
    })) as unknown as Record<string, unknown>;

    // yt-dlp names the file source.<ext>; the ext isn't always mp4 (webm/mkv),
    // so locate whatever it actually produced instead of assuming .mp4.
    const produced = (await fs.readdir(destDir)).find((f) => f.startsWith("source."));
    if (!produced) {
      throw new Error("yt-dlp finished but produced no output file");
    }
    const filePath = join(destDir, produced);
    const probed = await probe(filePath);
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
