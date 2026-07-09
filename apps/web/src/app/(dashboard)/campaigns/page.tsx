"use client";
import { useState } from "react";
import { apiSend, revalidateAll, useCampaigns, type CampaignDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { money, timeAgo } from "@/lib/format";

const PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;

export default function CampaignsPage() {
  const { data, isLoading } = useCampaigns();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <PageHeader
        title="Campaigns"
        subtitle="Each campaign turns a source video into reviewed, published clips"
        action={<Button onClick={() => setShowForm((s) => !s)}>{showForm ? "Close" : "+ New campaign"}</Button>}
      />

      {showForm && <NewCampaignForm onDone={() => setShowForm(false)} />}

      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No campaigns yet" hint="Create one to start the pipeline." />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {data.map((c) => (
            <CampaignCard key={c.id} campaign={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: CampaignDto }) {
  const [busy, setBusy] = useState(false);
  async function ingest() {
    setBusy(true);
    try {
      await apiSend(`/campaigns/${campaign.id}/ingest`, "POST");
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold">{campaign.name}</h3>
          <p className="text-sm" style={{ color: "var(--muted)" }}>{campaign.creator.name} · {campaign.sourcePlatform}</p>
        </div>
        <StatusBadge status={campaign.status} />
      </div>
      <div className="flex gap-2 mt-3 flex-wrap">
        {campaign.allowedPlatforms.map((p) => (
          <span key={p} className="text-xs px-2 py-0.5 rounded surface-2">{p}</span>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-4 text-sm">
        <div><div style={{ color: "var(--muted)" }} className="text-xs">Videos</div>{campaign.sourceVideoCount}</div>
        <div><div style={{ color: "var(--muted)" }} className="text-xs">Clips</div>{campaign.clipCount}</div>
        <div><div style={{ color: "var(--muted)" }} className="text-xs">Rate/1k</div>{money(campaign.revenueRatePerMille)}</div>
      </div>
      <div className="flex items-center justify-between mt-4">
        <span className="text-xs" style={{ color: "var(--muted)" }}>{timeAgo(campaign.createdAt)}</span>
        <Button variant="secondary" onClick={ingest} disabled={busy}>{busy ? "Queuing…" : "Ingest video"}</Button>
      </div>
    </Card>
  );
}

function NewCampaignForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [creatorName, setCreatorName] = useState("");
  const [creatorHandle, setCreatorHandle] = useState("");
  const [platforms, setPlatforms] = useState<string[]>(["TIKTOK", "YOUTUBE"]);
  const [rate, setRate] = useState("1.0");
  const [ingestNow, setIngestNow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend("/campaigns", "POST", {
        name,
        sourceVideoUrl: url,
        allowedPlatforms: platforms,
        revenueRatePerMille: Number(rate),
        creator: { name: creatorName, handle: creatorHandle },
        ingestNow,
      });
      await revalidateAll();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm";
  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Campaign name</label>
          <input required value={name} onChange={(e) => setName(e.target.value)} className={field} placeholder="Podcast Ep. 42" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Source video URL</label>
          <input required value={url} onChange={(e) => setUrl(e.target.value)} className={field} placeholder="https://youtube.com/watch?v=…" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Creator name</label>
          <input required value={creatorName} onChange={(e) => setCreatorName(e.target.value)} className={field} placeholder="Alex Rivera" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Creator handle</label>
          <input required value={creatorHandle} onChange={(e) => setCreatorHandle(e.target.value)} className={field} placeholder="alexrivera" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Revenue rate / 1000 views (USD)</label>
          <input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className={field} />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>Allowed platforms</label>
          <div className="flex gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))}
                className="text-xs px-2.5 py-1.5 rounded-lg border"
                style={{
                  background: platforms.includes(p) ? "var(--primary)" : "var(--surface-2)",
                  color: platforms.includes(p) ? "#fff" : "var(--muted)",
                  borderColor: "var(--border)",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={ingestNow} onChange={(e) => setIngestNow(e.target.checked)} />
          Start ingesting immediately
        </label>
        {error && <p className="text-sm md:col-span-2" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="md:col-span-2 flex gap-2">
          <Button type="submit" disabled={busy || platforms.length === 0}>{busy ? "Creating…" : "Create campaign"}</Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
