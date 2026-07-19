"use client";
import useSWR, { type SWRConfiguration, mutate as globalMutate } from "swr";
import type {
  CalibrationDto,
  CampaignDto,
  CategoryDto,
  ClipDetailDto,
  ClipDto,
  DiscoveredVideoDto,
  DistributeResult,
  DistributionOverview,
  OverviewDto,
  PostTask,
  PublishJobDto,
  SocialAccountDto,
  SourceVideoDto,
} from "@clipfactory/core/contracts";

// Same-origin: Next.js rewrites (next.config.mjs) proxy /api/* to the backend,
// which keeps the session cookie first-party.
const V1 = "/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function handle(res: Response) {
  if (!res.ok) {
    let code = "ERROR";
    let message = res.statusText;
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      /* non-json */
    }
    throw new ApiError(message, res.status, code);
  }
  return res.status === 204 ? null : res.json();
}

export function apiGet<T>(path: string): Promise<T> {
  return fetch(`${V1}${path}`, { credentials: "include" }).then(handle);
}

export function apiSend<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  return fetch(`${V1}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handle);
}

/** Upload a video file via multipart, reporting progress (0-1). Uses XHR for progress events. */
export function apiUpload<T>(
  path: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${V1}${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : (null as T));
        } catch {
          resolve(null as T);
        }
      } else {
        let message = xhr.statusText;
        let code = "ERROR";
        try {
          const body = JSON.parse(xhr.responseText);
          message = body?.error?.message ?? message;
          code = body?.error?.code ?? code;
        } catch {
          /* non-json */
        }
        reject(new ApiError(message, xhr.status, code));
      }
    };
    xhr.onerror = () => reject(new ApiError("Network error during upload", 0, "NETWORK"));
    xhr.send(form);
  });
}

const fetcher = <T>(path: string) => apiGet<T>(path);

/** Re-fetch every list/summary that could change after a pipeline or review action. */
export function revalidateAll() {
  return globalMutate(() => true, undefined, { revalidate: true });
}

// ── Typed hooks ──────────────────────────────────────────────────────────────

function useApi<T>(path: string | null, config?: SWRConfiguration) {
  return useSWR<T>(path, fetcher, config);
}

export const useOverview = () => useApi<OverviewDto>("/analytics/overview", { refreshInterval: 5000 });
export const useCampaigns = () => useApi<CampaignDto[]>("/campaigns", { refreshInterval: 8000 });
export const useVideos = () => useApi<SourceVideoDto[]>("/videos", { refreshInterval: 4000 });
export const useAccounts = () => useApi<SocialAccountDto[]>("/accounts");
export const useCategories = () => useApi<CategoryDto[]>("/categories");
export const useDiscovery = () =>
  useApi<DiscoveredVideoDto[]>("/discovery", { refreshInterval: 20000 });
export const usePublishJobs = (status?: string) =>
  useApi<PublishJobDto[]>(`/publish-jobs${status ? `?status=${status}` : ""}`, { refreshInterval: 5000 });

export function useClips(status?: string) {
  const qs = status ? `?status=${status}&take=100` : "?take=100";
  return useApi<{ items: ClipDto[]; total: number }>(`/clips${qs}`, { refreshInterval: 4000 });
}

/** The clip grid: best-scored first, filtered by kept/discarded. */
export function useClipGrid(opts?: { kept?: boolean; sourceVideoId?: string; status?: string }) {
  const params = new URLSearchParams({ sort: "score", take: "300" });
  if (opts?.kept !== undefined) params.set("kept", String(opts.kept));
  if (opts?.sourceVideoId) params.set("sourceVideoId", opts.sourceVideoId);
  if (opts?.status) params.set("status", opts.status);
  return useApi<{ items: ClipDto[]; total: number }>(`/clips?${params.toString()}`, {
    refreshInterval: 5000,
  });
}

/** Build the same-origin export URL (cookie-authed via the Next proxy). */
export function clipExportUrl(ids?: string[]): string {
  const q = ids && ids.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
  return `${V1}/clips/export${q}`;
}

/** Scheduler bundle (schedule.csv + media) for the distribution queue. */
export function distributionExportUrl(accountId?: string): string {
  return `${V1}/distribution/export${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
}

/** Human-readable summary of a distribute run: what queued and what was skipped. */
export function summarizeDistribute(r: DistributeResult): string {
  const head = r.jobsCreated > 0
    ? `Queued ${r.jobsCreated} post${r.jobsCreated === 1 ? "" : "s"}`
    : "No new posts queued";
  const reasons: string[] = [];
  if (r.skipped.noCategory) reasons.push(`${r.skipped.noCategory} no category`);
  if (r.skipped.noMatchingAccount) reasons.push(`${r.skipped.noMatchingAccount} no matching account`);
  if (r.skipped.alreadyDistributed) reasons.push(`${r.skipped.alreadyDistributed} already queued`);
  const skippedTotal = reasons.length ? ` · skipped ${r.skipped.noCategory + r.skipped.noMatchingAccount + r.skipped.alreadyDistributed}: ${reasons.join(", ")}` : "";
  return `${head} from ${r.clipsConsidered} clip${r.clipsConsidered === 1 ? "" : "s"}${skippedTotal}.`;
}

export const useClip = (id: string | null) => useApi<ClipDetailDto>(id ? `/clips/${id}` : null);

export const useCalibration = () => useApi<CalibrationDto>("/calibration", { refreshInterval: 15000 });

export const useDistributionOverview = () =>
  useApi<DistributionOverview>("/distribution/overview", { refreshInterval: 8000 });

export const useDistributionQueue = (accountId: string | null) =>
  useApi<PostTask[]>(accountId ? `/distribution/queue?accountId=${accountId}` : null, {
    refreshInterval: 8000,
  });

export type {
  CalibrationDto,
  CampaignDto,
  CategoryDto,
  ClipDto,
  ClipDetailDto,
  DiscoveredVideoDto,
  DistributeResult,
  DistributionOverview,
  OverviewDto,
  PostTask,
  PublishJobDto,
  SocialAccountDto,
  SourceVideoDto,
};
