"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "@/lib/auth-client";
import { useOverview } from "@/lib/api";

const NAV: Array<{ href: string; label: string; badge?: "review" }> = [
  { href: "/", label: "Overview" },
  { href: "/upload", label: "Upload" },
  { href: "/videos", label: "Video Queue" },
  { href: "/library", label: "Library" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { data: overview } = useOverview();
  const reviewCount = overview?.reviewQueueDepth ?? 0;

  return (
    <aside className="w-60 shrink-0 border-r flex flex-col" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="px-5 py-5 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="font-semibold text-lg flex items-center gap-2">
          <span className="w-6 h-6 rounded-md inline-flex items-center justify-center text-white text-sm" style={{ background: "var(--primary)" }}>C</span>
          Clip Factory
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors"
              style={{
                background: active ? "var(--surface-2)" : "transparent",
                color: active ? "var(--text)" : "var(--muted)",
              }}
            >
              <span>{item.label}</span>
              {item.badge === "review" && reviewCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full text-white" style={{ background: "var(--warning)" }}>
                  {reviewCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t text-sm" style={{ borderColor: "var(--border)" }}>
        <div className="px-3 py-2">
          <div className="truncate">{session?.user?.name ?? "…"}</div>
          <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{session?.user?.email}</div>
        </div>
        <button
          onClick={() => signOut().then(() => router.push("/login"))}
          className="w-full text-left px-3 py-2 rounded-lg text-sm"
          style={{ color: "var(--muted)" }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
