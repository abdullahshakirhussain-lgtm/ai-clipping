"use client";
import useSWR, { type SWRConfiguration, mutate as globalMutate } from "swr";
import type {
  CampaignDto,
  ClipDetailDto,
  ClipDto,
  OverviewDto,
  PublishJobDto,
  RevenueDto,
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
export const useRevenue = () => useApi<RevenueDto>("/analytics/revenue");
export const useCampaigns = () => useApi<CampaignDto[]>("/campaigns", { refreshInterval: 8000 });
export const useVideos = () => useApi<SourceVideoDto[]>("/videos", { refreshInterval: 4000 });
export const useAccounts = () => useApi<SocialAccountDto[]>("/accounts");
export const usePublishJobs = (status?: string) =>
  useApi<PublishJobDto[]>(`/publish-jobs${status ? `?status=${status}` : ""}`, { refreshInterval: 5000 });

export function useClips(status?: string) {
  const qs = status ? `?status=${status}&take=100` : "?take=100";
  return useApi<{ items: ClipDto[]; total: number }>(`/clips${qs}`, { refreshInterval: 4000 });
}

export const useClip = (id: string | null) => useApi<ClipDetailDto>(id ? `/clips/${id}` : null);

export type {
  CampaignDto,
  ClipDto,
  ClipDetailDto,
  OverviewDto,
  PublishJobDto,
  RevenueDto,
  SocialAccountDto,
  SourceVideoDto,
};
