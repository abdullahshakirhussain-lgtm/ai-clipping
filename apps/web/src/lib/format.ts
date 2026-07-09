export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n ?? 0);
}

export function money(n: number): string {
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(n ?? 0);
}

export function duration(sec: number): string {
  const s = Math.round(sec ?? 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS_COLORS: Record<string, string> = {
  READY_FOR_REVIEW: "var(--warning)",
  APPROVED: "var(--success)",
  PUBLISHED: "var(--success)",
  REJECTED: "var(--danger)",
  FAILED: "var(--danger)",
  ACTIVE: "var(--success)",
  DRAFT: "var(--muted)",
  RENDERING: "var(--primary)",
  ENHANCING: "var(--primary)",
  PUBLISHING: "var(--primary)",
  SCHEDULED: "var(--primary)",
};

export const statusColor = (status: string) => STATUS_COLORS[status] ?? "var(--muted)";
