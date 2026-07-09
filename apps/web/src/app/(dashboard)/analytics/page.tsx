"use client";
import { apiSend, useOverview } from "@/lib/api";
import { Button, Card, PageHeader, Spinner, StatCard, StatusBadge } from "@/components/ui";
import { compactNumber, money } from "@/lib/format";

export default function AnalyticsPage() {
  const { data, isLoading, mutate } = useOverview();
  if (isLoading || !data) return <Spinner />;

  async function sync() {
    await apiSend("/analytics/sync", "POST");
    setTimeout(() => mutate(), 1500);
  }

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Performance across platforms, creators, and campaigns"
        action={<Button variant="secondary" onClick={sync}>Sync metrics now</Button>}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatCard label="Views" value={compactNumber(data.totals.views)} />
        <StatCard label="Likes" value={compactNumber(data.totals.likes)} />
        <StatCard label="Comments" value={compactNumber(data.totals.comments)} />
        <StatCard label="Shares" value={compactNumber(data.totals.shares)} />
        <StatCard label="Watch time" value={`${compactNumber(data.totals.watchTimeSec / 3600)}h`} />
      </div>

      <Card className="mb-6">
        <h2 className="font-semibold mb-4">By platform</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: "var(--muted)" }}>
              <th className="pb-2 font-medium">Platform</th>
              <th className="pb-2 font-medium text-right">Posts</th>
              <th className="pb-2 font-medium text-right">Views</th>
              <th className="pb-2 font-medium text-right">Likes</th>
              <th className="pb-2 font-medium text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.byPlatform.map((p) => (
              <tr key={p.platform} className="border-t" style={{ borderColor: "var(--border)" }}>
                <td className="py-2"><StatusBadge status={p.platform} /></td>
                <td className="py-2 text-right tabular-nums">{p.posts}</td>
                <td className="py-2 text-right tabular-nums">{compactNumber(p.views)}</td>
                <td className="py-2 text-right tabular-nums">{compactNumber(p.likes)}</td>
                <td className="py-2 text-right tabular-nums">{money(p.revenue)}</td>
              </tr>
            ))}
            {data.byPlatform.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-center" style={{ color: "var(--muted)" }}>No metrics yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card>
        <h2 className="font-semibold mb-4">Top clips</h2>
        <div className="space-y-2">
          {data.topClips.map((c, i) => (
            <div key={c.clipId} className="flex items-center gap-3 text-sm">
              <span className="w-6 text-center" style={{ color: "var(--muted)" }}>{i + 1}</span>
              <span className="flex-1 truncate">{c.title ?? c.clipId}</span>
              <StatusBadge status={c.platform} />
              <span className="w-20 text-right tabular-nums">{compactNumber(c.views)} views</span>
              <span className="w-20 text-right tabular-nums" style={{ color: "var(--success)" }}>{money(c.revenue)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
