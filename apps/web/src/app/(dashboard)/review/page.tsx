"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiSend, revalidateAll, useAccounts, useClips, type ClipDto } from "@/lib/api";
import { Button, PageHeader, StatusBadge } from "@/components/ui";
import { compactNumber, duration } from "@/lib/format";

type ActionType = "APPROVE" | "REJECT" | "REGENERATE" | "IMPROVE_HOOK" | "IMPROVE_CAPTIONS";

const SHORTCUTS: Array<{ key: string; label: string; action: ActionType | "PUBLISH" }> = [
  { key: "A", label: "Approve", action: "APPROVE" },
  { key: "R", label: "Reject", action: "REJECT" },
  { key: "H", label: "Improve hook", action: "IMPROVE_HOOK" },
  { key: "C", label: "Improve captions", action: "IMPROVE_CAPTIONS" },
  { key: "G", label: "Regenerate", action: "REGENERATE" },
  { key: "P", label: "Approve + Publish", action: "PUBLISH" },
];

export default function ReviewPage() {
  const { data, isLoading, mutate } = useClips("READY_FOR_REVIEW");
  const { data: accounts } = useAccounts();
  const clips = useMemo(() => data?.items ?? [], [data]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const clip: ClipDto | undefined = clips[index];

  useEffect(() => {
    if (index >= clips.length && clips.length > 0) setIndex(clips.length - 1);
  }, [clips.length, index]);

  const act = useCallback(
    async (action: ActionType | "PUBLISH") => {
      if (!clip || busy) return;
      setBusy(true);
      try {
        if (action === "PUBLISH") {
          await apiSend(`/clips/${clip.id}/review`, "POST", { action: "APPROVE" });
          const targets = (accounts ?? []).filter((a) => clip.allowedPlatforms.includes(a.platform) && a.status === "ACTIVE");
          if (targets.length > 0) {
            await apiSend(`/clips/${clip.id}/publish`, "POST", { accountIds: targets.map((a) => a.id) });
            setFlash(`Published to ${targets.length} account(s)`);
          } else {
            setFlash("Approved (no active accounts to publish to)");
          }
        } else {
          const res = await apiSend<{ status: string; reprocessing: boolean }>(
            `/clips/${clip.id}/review`,
            "POST",
            { action },
          );
          setFlash(res.reprocessing ? "Sent back into the pipeline" : `Marked ${res.status.toLowerCase()}`);
        }
        // Optimistically drop the clip and advance
        mutate(
          data
            ? { items: clips.filter((c) => c.id !== clip.id), total: Math.max(0, data.total - 1) }
            : data,
          { revalidate: false },
        );
        void revalidateAll();
      } catch (err) {
        setFlash(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusy(false);
        setTimeout(() => setFlash(null), 2500);
      }
    },
    [clip, busy, accounts, clips, data, mutate],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toUpperCase();
      if (key === "ARROWRIGHT") return setIndex((i) => Math.min(i + 1, clips.length - 1));
      if (key === "ARROWLEFT") return setIndex((i) => Math.max(i - 1, 0));
      const match = SHORTCUTS.find((s) => s.key === key);
      if (match) {
        e.preventDefault();
        void act(match.action);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, clips.length]);

  if (isLoading) return <div className="p-10 text-sm" style={{ color: "var(--muted)" }}>Loading review queue…</div>;

  if (!clip) {
    return (
      <div>
        <PageHeader title="Review Queue" subtitle="The only manual step — aim for under 15 seconds per clip" />
        <div className="card p-12 text-center">
          <p className="text-lg font-medium">🎉 Queue is clear</p>
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>No clips awaiting review. New candidates appear here automatically.</p>
        </div>
      </div>
    );
  }

  const hooks = clip.hooks?.variants ?? [];

  return (
    <div>
      <PageHeader
        title="Review Queue"
        subtitle={`Clip ${index + 1} of ${clips.length} — keyboard: A R H C G P, ← →`}
      />

      {flash && (
        <div className="mb-4 px-4 py-2 rounded-lg text-sm" style={{ background: "var(--surface-2)" }}>{flash}</div>
      )}

      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        {/* Vertical preview */}
        <div className="card p-4">
          <div className="rounded-lg overflow-hidden bg-black aspect-[9/16] flex items-center justify-center">
            {clip.previewUrl ? (
              <video
                ref={videoRef}
                key={clip.id}
                src={clip.previewUrl}
                poster={clip.thumbnailUrl ?? undefined}
                controls
                autoPlay
                muted
                loop
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="text-center p-6" style={{ color: "var(--muted)" }}>
                <p className="text-sm">No rendered preview</p>
                <p className="text-xs mt-1">(seeded demo clip)</p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between mt-3 text-sm">
            <span style={{ color: "var(--muted)" }}>{duration(clip.durationSec)} · {clip.captionStyle}</span>
            <StatusBadge status={clip.status} />
          </div>
        </div>

        {/* Metadata + actions */}
        <div className="space-y-4">
          <div className="card p-5">
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Hook</div>
            <p className="text-lg font-medium">{hooks[0] ?? clip.title ?? "—"}</p>
            {hooks.length > 1 && (
              <div className="mt-2 space-y-1">
                {hooks.slice(1).map((h, i) => (
                  <p key={i} className="text-sm" style={{ color: "var(--muted)" }}>• {h}</p>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Title</div>
              <p className="text-sm">{clip.title ?? "—"}</p>
              <div className="text-xs uppercase tracking-wide mt-3 mb-1" style={{ color: "var(--muted)" }}>Hashtags</div>
              <p className="text-sm" style={{ color: "var(--primary)" }}>{clip.hashtags.join(" ")}</p>
            </div>
            <div className="card p-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                <Score label="Quality" value={clip.qualityScore} />
                <Score label="Viral" value={clip.viralScore} />
                <Score label="Engage" value={clip.estimatedEngagement} suffix="" />
              </div>
              <div className="text-xs mt-3" style={{ color: "var(--muted)" }}>
                {clip.campaignName} · {clip.creatorName}
              </div>
            </div>
          </div>

          <div className="card p-4">
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>Detection reason</div>
            <p className="text-sm">{clip.detectionReason ?? "—"}</p>
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => act("APPROVE")} disabled={busy}>Approve <kbd className="ml-1 opacity-60">A</kbd></Button>
            <Button variant="danger" onClick={() => act("REJECT")} disabled={busy}>Reject <kbd className="ml-1 opacity-60">R</kbd></Button>
            <Button variant="secondary" onClick={() => act("IMPROVE_HOOK")} disabled={busy}>Improve hook <kbd className="ml-1 opacity-60">H</kbd></Button>
            <Button variant="secondary" onClick={() => act("IMPROVE_CAPTIONS")} disabled={busy}>Improve captions <kbd className="ml-1 opacity-60">C</kbd></Button>
            <Button variant="secondary" onClick={() => act("REGENERATE")} disabled={busy}>Regenerate <kbd className="ml-1 opacity-60">G</kbd></Button>
            <Button variant="primary" onClick={() => act("PUBLISH")} disabled={busy}>Approve + Publish <kbd className="ml-1 opacity-60">P</kbd></Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Score({ label, value, suffix = "" }: { label: string; value: number | null; suffix?: string }) {
  const v = value ?? 0;
  const color = v >= 70 ? "var(--success)" : v >= 45 ? "var(--warning)" : "var(--danger)";
  return (
    <div>
      <div className="text-lg font-semibold" style={{ color }}>{Math.round(v)}{suffix}</div>
      <div className="text-xs" style={{ color: "var(--muted)" }}>{label}</div>
    </div>
  );
}
