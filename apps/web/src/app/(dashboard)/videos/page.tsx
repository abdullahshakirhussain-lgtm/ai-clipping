"use client";
import { useVideos } from "@/lib/api";
import { Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";

export default function VideosPage() {
  const { data, isLoading } = useVideos();
  return (
    <div>
      <PageHeader title="Video Queue" subtitle="Source videos moving through transcription → detection → render" />
      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No source videos yet" hint="Upload a video to see intake progress here." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="p-4 font-medium">Title</th>
                <th className="p-4 font-medium">Project</th>
                <th className="p-4 font-medium">Duration</th>
                <th className="p-4 font-medium">Clips</th>
                <th className="p-4 font-medium">Status</th>
                <th className="p-4 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="p-4 max-w-xs truncate">{v.title ?? v.originalUrl}</td>
                  <td className="p-4">{v.campaignName}</td>
                  <td className="p-4">{v.durationSec ? duration(v.durationSec) : "—"}</td>
                  <td className="p-4">{v.clipCount}</td>
                  <td className="p-4"><StatusBadge status={v.status} />{v.error && <div className="text-xs mt-1" style={{ color: "var(--danger)" }}>{v.error}</div>}</td>
                  <td className="p-4 text-xs" style={{ color: "var(--muted)" }}>{timeAgo(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
