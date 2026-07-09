"use client";
import { apiSend, revalidateAll, usePublishJobs, type PublishJobDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";

export default function PublishingPage() {
  const { data, isLoading } = usePublishJobs();
  const active = (data ?? []).filter((j) => j.status !== "PUBLISHED");

  return (
    <div>
      <PageHeader title="Publishing Queue" subtitle="Scheduling, retries, and per-attempt logs across all accounts" />
      {isLoading ? (
        <Spinner />
      ) : active.length === 0 ? (
        <EmptyState title="Nothing in the publishing queue" hint="Approved clips you publish will appear here." />
      ) : (
        <div className="space-y-3">
          {active.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: PublishJobDto }) {
  async function retry() {
    await apiSend(`/publish-jobs/${job.id}/retry`, "POST");
    await revalidateAll();
  }
  async function cancel() {
    await apiSend(`/publish-jobs/${job.id}/cancel`, "POST");
    await revalidateAll();
  }
  return (
    <Card>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="font-medium">{job.clipTitle ?? job.clipId}</div>
          <div className="text-sm" style={{ color: "var(--muted)" }}>
            {job.platform} · {job.accountHandle} · attempt {job.attempts}/{job.maxAttempts}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={job.status} />
          {job.status === "FAILED" && <Button variant="secondary" onClick={retry}>Retry</Button>}
          {(job.status === "QUEUED" || job.status === "SCHEDULED") && (
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
          )}
        </div>
      </div>
      {job.lastError && <p className="text-xs mt-2" style={{ color: "var(--danger)" }}>{job.lastError}</p>}
      {job.attemptsLog.length > 0 && (
        <div className="mt-3 text-xs space-y-1" style={{ color: "var(--muted)" }}>
          {job.attemptsLog.slice(0, 3).map((a, i) => (
            <div key={i}>
              {a.success ? "✓" : "✕"} {timeAgo(a.startedAt)} — {a.success ? "ok" : "failed"}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
