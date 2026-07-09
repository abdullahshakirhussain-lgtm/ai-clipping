"use client";
import { useRevenue } from "@/lib/api";
import { Card, EmptyState, PageHeader, Spinner, StatCard } from "@/components/ui";
import { compactNumber, money } from "@/lib/format";

export default function RevenuePage() {
  const { data, isLoading } = useRevenue();
  if (isLoading || !data) return <Spinner />;

  return (
    <div>
      <PageHeader title="Revenue" subtitle="Earnings by campaign, driven by views × rate per 1000" />
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <StatCard label="Total revenue" value={money(data.totalRevenue)} accent="var(--success)" />
        <StatCard label="Total views" value={compactNumber(data.totalViews)} />
        <StatCard
          label="Effective RPM"
          value={money(data.totalViews > 0 ? (data.totalRevenue / data.totalViews) * 1000 : 0)}
        />
      </div>

      {data.byCampaign.length === 0 ? (
        <EmptyState title="No revenue yet" hint="Revenue accrues once clips are published and metrics sync." />
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="p-4 font-medium">Campaign</th>
                <th className="p-4 font-medium">Creator</th>
                <th className="p-4 font-medium text-right">Posts</th>
                <th className="p-4 font-medium text-right">Views</th>
                <th className="p-4 font-medium text-right">Rate/1k</th>
                <th className="p-4 font-medium text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.byCampaign.map((c) => (
                <tr key={c.campaignId} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="p-4">{c.name}</td>
                  <td className="p-4" style={{ color: "var(--muted)" }}>{c.creatorName}</td>
                  <td className="p-4 text-right tabular-nums">{c.posts}</td>
                  <td className="p-4 text-right tabular-nums">{compactNumber(c.views)}</td>
                  <td className="p-4 text-right tabular-nums">{money(c.ratePerMille)}</td>
                  <td className="p-4 text-right tabular-nums" style={{ color: "var(--success)" }}>{money(c.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
