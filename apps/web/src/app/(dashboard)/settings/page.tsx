"use client";
import { useSession } from "@/lib/auth-client";
import { Card, PageHeader } from "@/components/ui";

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
            Switch from mock to live by adding provider keys and restarting.
          </p>
        </Card>
      </div>
    </div>
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
