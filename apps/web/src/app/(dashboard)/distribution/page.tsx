"use client";
import { useEffect, useMemo, useState } from "react";
import {
  apiSend,
  distributionExportUrl,
  revalidateAll,
  summarizeDistribute,
  useDistributionOverview,
  useDistributionQueue,
  type DistributeResult,
  type DistributionOverview,
  type PostTask,
} from "@/lib/api";
import { sendJob, subscribe, useExtensionConnected } from "@/lib/extension";
import { Button, Card, EmptyState, PageHeader, Spinner, StatCard } from "@/components/ui";

export default function DistributionPage() {
  const { data: overview } = useDistributionOverview();
  const extConnected = useExtensionConnected();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function distribute() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiSend<DistributeResult>("/distribute", "POST", {});
      setMsg(summarizeDistribute(r));
      await revalidateAll();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Distribute failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Distribution"
        subtitle="Route kept clips to your category accounts, then work each account's queue."
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => { const a = document.createElement("a"); a.href = distributionExportUrl(); a.click(); }}>
              Export for scheduler
            </Button>
            <Button onClick={distribute} disabled={busy}>{busy ? "Distributing…" : "Distribute kept clips"}</Button>
          </div>
        }
      />
      {msg && <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>{msg}</p>}

      <div className="flex items-center gap-2 mb-4 text-sm" style={{ color: "var(--muted)" }}>
        <span
          className="inline-block rounded-full"
          style={{ width: 8, height: 8, background: extConnected ? "var(--success)" : "var(--muted)" }}
        />
        {extConnected
          ? "Poster extension connected — one-click posting enabled on YouTube, TikTok & Facebook clips."
          : "Poster extension not detected — install it to post in one click (manual copy/download still works)."}
      </div>

      {!overview ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <StatCard label="Posted today" value={overview.totals.postedToday} accent="var(--success)" />
            <StatCard label="Scheduled pending" value={overview.totals.scheduledPending} accent="var(--warning)" />
            <StatCard label="Accounts" value={overview.accounts.length} />
          </div>

          <div className="grid lg:grid-cols-[320px_1fr] gap-6">
            <AccountList overview={overview} selected={selected} onSelect={setSelected} />
            <div>
              {selected ? (
                <AccountQueue accountId={selected} extConnected={extConnected} />
              ) : (
                <EmptyState title="Pick an account" hint="Select an account on the left to work its posting queue." />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
};
const PLATFORM_ORDER = ["YOUTUBE", "TIKTOK", "FACEBOOK", "INSTAGRAM"];

/** Accounts grouped under collapsible platform pills, so 15+ accounts stay tidy. */
function AccountList({
  overview,
  selected,
  onSelect,
}: {
  overview: DistributionOverview;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, DistributionOverview["accounts"]>();
    for (const a of overview.accounts) {
      if (!m.has(a.platform)) m.set(a.platform, []);
      m.get(a.platform)!.push(a);
    }
    const known = PLATFORM_ORDER.filter((p) => m.has(p));
    const rest = [...m.keys()].filter((p) => !PLATFORM_ORDER.includes(p));
    return [...known, ...rest].map((p) => [p, m.get(p)!] as const);
  }, [overview]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Keep the selected account's platform open so its queue context stays visible.
  useEffect(() => {
    const sel = overview.accounts.find((a) => a.id === selected);
    if (sel) setExpanded((prev) => (prev.has(sel.platform) ? prev : new Set(prev).add(sel.platform)));
  }, [selected, overview.accounts]);

  function toggle(p: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  }

  return (
    <Card className="p-0 overflow-hidden self-start">
      <div className="max-h-[70vh] overflow-y-auto">
        {groups.map(([platform, accts]) => {
          const posted = accts.reduce((n, a) => n + a.postedToday, 0);
          const goal = accts.reduce((n, a) => n + a.postsPerDay, 0);
          const queued = accts.reduce((n, a) => n + a.scheduledPending, 0);
          const open = expanded.has(platform);
          return (
            <div key={platform} className="border-t first:border-t-0" style={{ borderColor: "var(--border)" }}>
              <button
                onClick={() => toggle(platform)}
                className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-2"
                style={{ background: "var(--surface-2)" }}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span className="text-xs w-3 inline-block" style={{ color: "var(--muted)" }}>{open ? "▾" : "▸"}</span>
                  {PLATFORM_LABEL[platform] ?? platform}
                  <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>({accts.length})</span>
                </span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  <span style={{ color: "var(--success)" }}>{posted}</span>/{goal} today
                  {queued > 0 && <> · <span style={{ color: "var(--warning)" }}>{queued} queued</span></>}
                </span>
              </button>
              {open &&
                accts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onSelect(a.id)}
                    className="w-full text-left pl-8 pr-3 py-2.5 border-t flex items-center justify-between gap-2"
                    style={{
                      borderColor: "var(--border)",
                      background: selected === a.id ? "var(--surface)" : "transparent",
                      outline: selected === a.id ? "1px solid var(--primary)" : "none",
                      outlineOffset: "-1px",
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{a.handle}</div>
                      <div className="text-xs capitalize" style={{ color: "var(--muted)" }}>{a.category}</div>
                    </div>
                    <div className="text-right text-xs shrink-0">
                      <div><span style={{ color: "var(--success)" }}>{a.postedToday}</span>/{a.postsPerDay}</div>
                      {a.scheduledPending > 0 && (
                        <div style={{ color: "var(--warning)" }}>{a.scheduledPending} queued</div>
                      )}
                    </div>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function AccountQueue({ accountId, extConnected }: { accountId: string; extConnected: boolean }) {
  const { data: tasks, isLoading } = useDistributionQueue(accountId);
  if (isLoading) return <Spinner />;
  const pending = (tasks ?? []).filter((t) => t.status === "SCHEDULED");
  const done = (tasks ?? [])
    .filter((t) => t.status === "PUBLISHED")
    .sort((a, b) => (b.scheduledAt ?? "").localeCompare(a.scheduledAt ?? ""))
    .slice(0, 30);

  if (pending.length === 0 && done.length === 0)
    return <EmptyState title="Queue empty" hint="No scheduled posts for this account. Distribute kept clips to fill it." />;

  return (
    <div className="space-y-5">
      {pending.length > 0 ? (
        <div className="space-y-3">
          {pending.map((t) => <PostCard key={t.jobId} task={t} extConnected={extConnected} />)}
        </div>
      ) : (
        <div className="text-sm px-3 py-2.5 rounded-lg surface-2 border" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          All caught up — nothing pending for this account.
        </div>
      )}

      {done.length > 0 && (
        <div>
          <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>
            Posted ({done.length})
          </div>
          <div className="flex flex-col gap-1">
            {done.map((t) => <DoneRow key={t.jobId} task={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}

/** A posted clip, checked off and de-emphasized so only pending work stands out. */
function DoneRow({ task }: { task: PostTask }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg surface-2" style={{ opacity: 0.7 }}>
      <span style={{ color: "var(--success)" }}>✓</span>
      <span className="text-sm truncate flex-1" style={{ color: "var(--muted)" }}>
        {task.title ?? "Untitled clip"}
      </span>
      {task.externalUrl && (
        <a href={task.externalUrl} target="_blank" rel="noreferrer" className="text-xs shrink-0" style={{ color: "var(--primary)" }}>
          view ↗
        </a>
      )}
    </div>
  );
}

function PostCard({ task, extConnected }: { task: PostTask; extConnected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [extStatus, setExtStatus] = useState<string | null>(null);

  const caption = [task.title, task.description, task.hashtags.join(" ")].filter(Boolean).join("\n\n");
  const AUTOMATED: PostTask["platform"][] = ["YOUTUBE", "TIKTOK", "FACEBOOK"];
  const canOneClick = extConnected && AUTOMATED.includes(task.platform) && !!task.previewUrl;
  const platformLabel =
    task.platform === "TIKTOK" ? "TikTok" : task.platform === "FACEBOOK" ? "Facebook" : task.platform === "YOUTUBE" ? "YouTube" : "platform";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await revalidateAll(); } finally { setBusy(false); }
  }

  // Listen for this job's progress/result from the extension. On a captured URL
  // we auto-mark the job posted; the manual paste box stays as a fallback.
  useEffect(() => {
    const unsub = subscribe((m) => {
      if (m.jobId !== task.jobId) return;
      if (m.kind === "status" && m.message) setExtStatus(m.message);
      else if (m.kind === "result") {
        if (m.url) {
          setUrl(m.url);
          setExtStatus("Posted ✓ — marking done");
          void act(() => apiSend(`/jobs/${task.jobId}/posted`, "POST", { url: m.url }));
        } else {
          setExtStatus(`Error: ${m.error ?? "unknown"}`);
        }
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.jobId]);

  function postViaExtension() {
    if (!task.previewUrl) return;
    setExtStatus("Sending to extension…");
    sendJob({
      jobId: task.jobId,
      platform: task.platform as "YOUTUBE" | "TIKTOK" | "FACEBOOK",
      downloadUrl: task.previewUrl,
      filename: `clip-${task.jobId}.mp4`,
      title: task.title ?? "Untitled clip",
      description: task.description ?? "",
      hashtags: task.hashtags,
      channelId: task.channelId,
    });
  }

  return (
    <Card className="flex gap-4">
      <div className="bg-black rounded-lg overflow-hidden shrink-0" style={{ width: 120, aspectRatio: "9/16" }}>
        {task.previewUrl && (
          <video src={task.previewUrl} poster={task.thumbnailUrl ?? undefined} controls preload="none" className="w-full h-full object-contain" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium line-clamp-1">{task.title ?? "Untitled clip"}</div>
          <div className="text-xs shrink-0" style={{ color: "var(--muted)" }}>
            {task.scheduledAt ? new Date(task.scheduledAt).toLocaleString() : "unscheduled"}
          </div>
        </div>
        {task.hashtags.length > 0 && (
          <div className="text-[11px] mt-1 truncate" style={{ color: "var(--muted)" }}>{task.hashtags.join(" ")}</div>
        )}
        <div className="flex gap-2 mt-3 flex-wrap">
          {canOneClick && (
            <Button onClick={postViaExtension} disabled={busy}>Post to {platformLabel}</Button>
          )}
          <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(caption); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? "Copied ✓" : "Copy caption"}
          </Button>
          {task.previewUrl && (
            <a href={task.previewUrl} download className="px-3.5 py-2 rounded-lg text-sm font-medium surface-2 border" style={{ borderColor: "var(--border)" }}>
              Download
            </a>
          )}
          <Button variant="ghost" onClick={() => act(() => apiSend(`/jobs/${task.jobId}/skip`, "POST"))} disabled={busy}>Skip</Button>
        </div>
        {extStatus && (
          <div className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>{extStatus}</div>
        )}
        <div className="flex gap-2 mt-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste the posted URL…"
            className="flex-1 px-3 py-2 rounded-lg surface-2 border outline-none text-sm"
            style={{ borderColor: "var(--border)" }}
          />
          <Button
            onClick={() => act(() => apiSend(`/jobs/${task.jobId}/posted`, "POST", { url }))}
            disabled={busy || !/^https?:\/\//.test(url)}
          >
            Mark posted
          </Button>
        </div>
      </div>
    </Card>
  );
}
