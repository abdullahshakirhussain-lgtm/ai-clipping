"use client";
import { useState } from "react";
import {
  apiSend,
  distributionExportUrl,
  revalidateAll,
  useDistributionOverview,
  useDistributionQueue,
  type DistributionOverview,
  type PostTask,
} from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner, StatCard } from "@/components/ui";

export default function DistributionPage() {
  const { data: overview } = useDistributionOverview();
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function distribute() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiSend<{ jobsCreated: number; clipsConsidered: number }>("/distribute", "POST");
      setMsg(`Routed ${r.clipsConsidered} clips → ${r.jobsCreated} new scheduled posts.`);
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
                <AccountQueue accountId={selected} />
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

function AccountList({
  overview,
  selected,
  onSelect,
}: {
  overview: DistributionOverview;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="p-0 overflow-hidden self-start">
      <div className="max-h-[70vh] overflow-y-auto">
        {overview.accounts.map((a) => (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            className="w-full text-left p-3 border-t first:border-t-0 flex items-center justify-between gap-2"
            style={{
              borderColor: "var(--border)",
              background: selected === a.id ? "var(--surface-2)" : "transparent",
            }}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{a.handle}</div>
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {a.platform} · {a.category}
              </div>
            </div>
            <div className="text-right text-xs shrink-0">
              <div><span style={{ color: "var(--success)" }}>{a.postedToday}</span>/{a.postsPerDay} today</div>
              {a.scheduledPending > 0 && (
                <div style={{ color: "var(--warning)" }}>{a.scheduledPending} queued</div>
              )}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}

function AccountQueue({ accountId }: { accountId: string }) {
  const { data: tasks, isLoading } = useDistributionQueue(accountId);
  if (isLoading) return <Spinner />;
  if (!tasks || tasks.length === 0)
    return <EmptyState title="Queue empty" hint="No scheduled posts for this account. Distribute kept clips to fill it." />;
  return (
    <div className="space-y-3">
      {tasks.map((t) => <PostCard key={t.jobId} task={t} />)}
    </div>
  );
}

function PostCard({ task }: { task: PostTask }) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const caption = [task.title, task.description, task.hashtags.join(" ")].filter(Boolean).join("\n\n");

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await revalidateAll(); } finally { setBusy(false); }
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
