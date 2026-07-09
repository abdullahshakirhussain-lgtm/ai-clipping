"use client";
import { useState } from "react";
import { apiSend, revalidateAll, useAccounts } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";

const PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;

export default function AccountsPage() {
  const { data, isLoading } = useAccounts();
  const [showForm, setShowForm] = useState(false);

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Social accounts used for publishing. Credentials require an approved platform app."
        action={<Button onClick={() => setShowForm((s) => !s)}>{showForm ? "Close" : "+ Add account"}</Button>}
      />

      {showForm && <NewAccountForm onDone={() => setShowForm(false)} />}

      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No accounts yet" hint="Add one to publish clips. Mock publishing works without credentials." />
      ) : (
        <div className="grid md:grid-cols-3 gap-4">
          {data.map((a) => (
            <Card key={a.id}>
              <div className="flex items-center justify-between mb-2">
                <StatusBadge status={a.platform} />
                <StatusBadge status={a.status} />
              </div>
              <div className="font-medium">{a.handle}</div>
              <div className="text-sm" style={{ color: "var(--muted)" }}>{a.displayName}</div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                <div><div className="text-xs" style={{ color: "var(--muted)" }}>Daily quota</div>{a.dailyQuota}</div>
                <div><div className="text-xs" style={{ color: "var(--muted)" }}>Posts</div>{a.publishJobCount}</div>
              </div>
              <div className="text-xs mt-3" style={{ color: a.hasCredentials ? "var(--success)" : "var(--warning)" }}>
                {a.hasCredentials ? "Credentials set" : "No credentials (mock only)"}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function NewAccountForm({ onDone }: { onDone: () => void }) {
  const [platform, setPlatform] = useState<string>("TIKTOK");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [quota, setQuota] = useState("20");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend("/accounts", "POST", {
        platform,
        handle,
        displayName: displayName || undefined,
        dailyQuota: Number(quota),
      });
      await revalidateAll();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm";
  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={field}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Handle</label>
          <input required value={handle} onChange={(e) => setHandle(e.target.value)} className={field} placeholder="@myhandle" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Display name</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={field} />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Daily quota</label>
          <input type="number" value={quota} onChange={(e) => setQuota(e.target.value)} className={field} />
        </div>
        {error && <p className="text-sm md:col-span-2" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="md:col-span-2 flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add account"}</Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
