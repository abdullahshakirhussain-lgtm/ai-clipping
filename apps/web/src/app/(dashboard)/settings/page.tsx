"use client";
import { useState } from "react";
import { useSession } from "@/lib/auth-client";
import { apiSend, revalidateAll } from "@/lib/api";
import { Button, Card, PageHeader } from "@/components/ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function SettingsPage() {
  const { data: session } = useSession();
  return (
    <div>
      <PageHeader title="Settings" subtitle="Account and system configuration" />
      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <h2 className="font-semibold mb-3">Profile</h2>
          <Row label="Name" value={session?.user?.name} />
          <Row label="Email" value={session?.user?.email} />
          <Row label="Role" value={(session?.user as { role?: string })?.role ?? "REVIEWER"} />
        </Card>
        <Card>
          <h2 className="font-semibold mb-3">System</h2>
          <Row label="API" value={API_URL} />
          <Row label="API docs" value={<a href={`${API_URL}/docs`} target="_blank" rel="noreferrer" style={{ color: "var(--primary)" }}>Open OpenAPI reference →</a>} />
          <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
            Drivers (AI, storage, queue, publishing) are configured via the API's <code>.env</code>.
          </p>
        </Card>
      </div>
      <DangerZone />
    </div>
  );
}

function DangerZone() {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function wipe() {
    setBusy(true);
    setMsg(null);
    try {
      await apiSend("/system/wipe", "POST", { confirm: "WIPE" });
      await revalidateAll();
      setConfirm("");
      setMsg("All data wiped.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Wipe failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6" >
      <h2 className="font-semibold mb-1" style={{ color: "var(--danger)" }}>Danger zone</h2>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
        Wipe every video, clip, post-task and account. Irreversible. Type <b>WIPE</b> to confirm.
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="WIPE"
          className="px-3 py-2 rounded-lg surface-2 border outline-none text-sm"
          style={{ borderColor: "var(--border)" }}
        />
        <Button variant="danger" onClick={wipe} disabled={busy || confirm !== "WIPE"}>
          {busy ? "Wiping…" : "Wipe all data"}
        </Button>
        {msg && <span className="text-sm" style={{ color: "var(--muted)" }}>{msg}</span>}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 border-t text-sm first:border-t-0" style={{ borderColor: "var(--border)" }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span className="text-right">{value ?? "—"}</span>
    </div>
  );
}
