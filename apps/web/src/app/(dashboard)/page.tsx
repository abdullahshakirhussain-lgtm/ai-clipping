"use client";
import Link from "next/link";
import { useOverview } from "@/lib/api";
import { Card, PageHeader, Spinner, StatCard, StatusBadge } from "@/components/ui";
import { compactNumber, money } from "@/lib/format";

const PIPELINE_ORDER = [
  "CANDIDATE",
  "RENDERING",
  "ENHANCING",
  "READY_FOR_REVIEW",
  "APPROVED",
  "PUBLISHING",
  "PUBLISHED",
];

export default function OverviewPage() {
  const { data, isLoading } = useOverview();
  if (isLoading || !data) return <Spinner />;

  const clipCount = (s: string) => data.clipCounts.find((c) => c.status === s)?.count ?? 0;

  return (
    <div>
      <PageHeader title="Overview" subtitle="Pipeline health and today's production at a glance" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Published today" value={data.publishedToday} accent="var(--success)" />
        <StatCard label="Awaiting review" value={data.reviewQueueDepth} accent="var(--warning)" hint="the only manual step" />
        <StatCard label="Total views" value={compactNumber(data.totals.views)} />
        <StatCard label="Revenue" value={money(data.totals.revenue)} accent="var(--success)" />
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
                  <div className="w-36 shrink-0"><StatusBadge status={status} /></div>
                  <div className="flex-1 h-2 rounded-full surface-2 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(count / max) * 100}%`, background: "var(--primary)" }} />
                  </div>
                  <div className="w-10 text-right text-sm tabular-nums">{count}</div>
                </div>
              );
            })}
          </div>
          <Link href="/review" className="inline-block mt-4 text-sm" style={{ color: "var(--primary)" }}>
            Go to review queue →
          </Link>
        </Card>

        <Card>
          <h2 className="font-semibold mb-4">Queue health</h2>
          <div className="space-y-2 text-sm">
            {data.queues.map((q) => (
              <div key={q.queue} className="flex items-center justify-between">
                <span style={{ color: "var(--muted)" }}>{q.queue}</span>
                <span className="tabular-nums">
                  {q.active > 0 && <span style={{ color: "var(--primary)" }}>{q.active}▶ </span>}
                  {q.waiting}⋯
                  {q.failed > 0 && <span style={{ color: "var(--danger)" }}> {q.failed}✕</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <h2 className="font-semibold mb-4">Top performing clips</h2>
        {data.topClips.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No published clips yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="pb-2 font-medium">Title</th>
                <th className="pb-2 font-medium">Platform</th>
                <th className="pb-2 font-medium text-right">Views</th>
                <th className="pb-2 font-medium text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.topClips.map((c) => (
                <tr key={c.clipId} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-2 pr-2 max-w-xs truncate">{c.title ?? c.clipId}</td>
                  <td className="py-2"><StatusBadge status={c.platform} /></td>
                  <td className="py-2 text-right tabular-nums">{compactNumber(c.views)}</td>
                  <td className="py-2 text-right tabular-nums">{money(c.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
