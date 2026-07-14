"use client";
import Link from "next/link";
import { useOverview } from "@/lib/api";
import { Card, PageHeader, Spinner, StatCard, StatusBadge } from "@/components/ui";

const PIPELINE_ORDER = [
  "CANDIDATE",
  "RENDERING",
  "ENHANCING",
  "APPROVED",
  "REJECTED",
  "FAILED",
];

/** Plain-English names for the internal job queues. */
const QUEUE_LABELS: Record<string, string> = {
  "video.download": "Fetching source",
  "video.transcribe": "Transcribing",
  "clip.detect": "Detecting clips",
  "clip.render": "Rendering",
  "clip.enhance": "Enhancing",
  "publish.execute": "Publishing",
};

function queueLabel(name: string): string {
  return QUEUE_LABELS[name] ?? name.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default function OverviewPage() {
  const { data, isLoading } = useOverview();
  if (isLoading || !data) return <Spinner />;

  const clipCount = (s: string) => data.clipCounts.find((c) => c.status === s)?.count ?? 0;
  const totalClips = data.clipCounts.reduce((n, c) => n + c.count, 0);
  const totalVideos = data.videoCounts.reduce((n, c) => n + c.count, 0);
  const processing = data.videoCounts
    .filter((c) => !["PROCESSED", "FAILED"].includes(c.status))
    .reduce((n, c) => n + c.count, 0);

  return (
    <div>
      <PageHeader title="Overview" subtitle="Pipeline health at a glance" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Videos" value={totalVideos} hint="uploaded sources" />
        <StatCard label="Processing" value={processing} accent="var(--warning)" hint="still in the pipeline" />
        <StatCard label="Clips" value={totalClips} accent="var(--primary)" />
        <StatCard label="Ready to export" value={clipCount("APPROVED")} accent="var(--success)" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <h2 className="font-semibold mb-4">Clip pipeline</h2>
          <div className="space-y-2">
            {PIPELINE_ORDER.map((status) => {
              const count = clipCount(status);
              const max = Math.max(1, ...PIPELINE_ORDER.map(clipCount));
              return (
                <div key={status} className="flex items-center gap-3">
                  <div className="w-36 shrink-0">
                    <StatusBadge status={status} />
                  </div>
                  <div className="flex-1 h-2 rounded-full surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(count / max) * 100}%`, background: "var(--primary)" }}
                    />
                  </div>
                  <div className="w-10 text-right text-sm tabular-nums">{count}</div>
                </div>
              );
            })}
          </div>
          <Link href="/library" className="inline-block mt-4 text-sm" style={{ color: "var(--primary)" }}>
            Go to library →
          </Link>
        </Card>

        <Card>
          <h2 className="font-semibold mb-4">Pipeline activity</h2>
          <div className="space-y-2 text-sm">
            {data.queues.map((q) => {
              const idle = q.active === 0 && q.waiting === 0 && q.failed === 0;
              return (
                <div key={q.queue} className="flex items-center justify-between">
                  <span style={{ color: "var(--muted)" }}>{queueLabel(q.queue)}</span>
                  <span className="tabular-nums text-xs">
                    {idle ? (
                      <span style={{ color: "var(--muted)" }}>idle</span>
                    ) : (
                      <span className="flex items-center gap-2">
                        {q.active > 0 && <span style={{ color: "var(--primary)" }}>{q.active} running</span>}
                        {q.waiting > 0 && <span style={{ color: "var(--muted)" }}>{q.waiting} queued</span>}
                        {q.failed > 0 && <span style={{ color: "var(--danger)" }}>{q.failed} failed</span>}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
