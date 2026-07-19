"use client";
import { useVideos, type SourceVideoDto } from "@/lib/api";
import { Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";
import { duration, timeAgo } from "@/lib/format";

const STYLE_LABEL: Record<string, string> = {
  "bold-center": "Bold white",
  "yellow-pop": "Yellow pop",
  "clean-bottom": "Clean / subtle",
};
const COMMENTARY_LABEL: Record<string, string> = {
  off: "",
  intro_outro: "Commentary: intro+outro",
  interject: "Commentary: interjections",
  full: "Commentary: full",
};

/**
 * What this video was ACTUALLY ingested with. These are captured at upload time
 * and baked in, so showing them is the only way to tell whether a setting took
 * effect — changing the Upload form afterwards does nothing to existing videos.
 */
function settingsOf(v: SourceVideoDto): string[] {
  const out: string[] = [];
  if (v.subtitlesOnly) out.push("Subtitles only");
  if (v.untouched) out.push("Untouched");
  if (v.commentaryMode !== "off") out.push(COMMENTARY_LABEL[v.commentaryMode] ?? v.commentaryMode);
  out.push(`${STYLE_LABEL[v.captionStyle] ?? v.captionStyle} · ${v.captionPosition}`);
  if (v.reframe) out.push("Smart framing");
  if (v.autoEnhance) out.push("Smart SFX");
  if (v.category) out.push(v.category);
  return out;
}

export default function VideosPage() {
  const { data, isLoading } = useVideos();
  return (
    <div>
      <PageHeader
        title="Video Queue"
        subtitle="Source videos moving through transcription → detection → render. Settings are fixed at upload."
      />
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
                <th className="p-4 font-medium">Rendered with</th>
                <th className="p-4 font-medium">Duration</th>
                <th className="p-4 font-medium">Clips</th>
                <th className="p-4 font-medium">Status</th>
                <th className="p-4 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.id} className="border-t align-top" style={{ borderColor: "var(--border)" }}>
                  <td className="p-4 max-w-[16rem] truncate">
                    {v.title ?? v.originalUrl}
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{v.campaignName}</div>
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap gap-1 max-w-sm">
                      {settingsOf(v).map((s) => (
                        <span
                          key={s}
                          className="text-[10px] px-1.5 py-0.5 rounded surface-2 border capitalize"
                          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                        >
                          {s}
                        </span>
                      ))}
                      {(v.context || v.autoContext) && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded surface-2 border cursor-help"
                          style={{ borderColor: "var(--border)", color: "var(--muted)" }}
                          title={[v.context, v.autoContext].filter(Boolean).join("\n— auto: ")}
                        >
                          📝 context
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">{v.durationSec ? duration(v.durationSec) : "—"}</td>
                  <td className="p-4">{v.clipCount}</td>
                  <td className="p-4">
                    <StatusBadge status={v.status} />
                    {v.error && <div className="text-xs mt-1" style={{ color: "var(--danger)" }}>{v.error}</div>}
                  </td>
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
