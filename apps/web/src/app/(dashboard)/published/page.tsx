"use client";
import { usePublishJobs } from "@/lib/api";
import { Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { timeAgo } from "@/lib/format";

export default function PublishedPage() {
  const { data, isLoading } = usePublishJobs("PUBLISHED");
  return (
    <div>
      <PageHeader title="Published" subtitle="Every clip that made it live, with links to the platform post" />
      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="Nothing published yet" hint="Approve and publish clips from the review queue." />
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.map((job) => (
            <Card key={job.id}>
              <div className="flex items-center justify-between mb-2">
                <StatusBadge status={job.platform} />
                <span className="text-xs" style={{ color: "var(--muted)" }}>{job.publishedAt ? timeAgo(job.publishedAt) : ""}</span>
              </div>
              <div className="font-medium text-sm mb-1 line-clamp-2">{job.clipTitle ?? job.clipId}</div>
              <div className="text-xs mb-3" style={{ color: "var(--muted)" }}>{job.accountHandle} · {job.campaignName}</div>
              {job.externalUrl && (
                <a href={job.externalUrl} target="_blank" rel="noreferrer" className="text-sm" style={{ color: "var(--primary)" }}>
                  View post →
                </a>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
