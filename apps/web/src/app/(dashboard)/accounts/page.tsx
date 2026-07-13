"use client";
import { useMemo, useState } from "react";
import { apiSend, revalidateAll, useAccounts, type SocialAccountDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner, StatusBadge } from "@/components/ui";

const PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE"] as const;

export default function AccountsPage() {
  const { data, isLoading } = useAccounts();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SocialAccountDto | null>(null);

  const byCategory = useMemo(() => {
    const m = new Map<string, SocialAccountDto[]>();
    for (const a of data ?? []) {
      if (!m.has(a.category)) m.set(a.category, []);
      m.get(a.category)!.push(a);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Accounts"
        subtitle="Your posting accounts, grouped by category. Clips route to accounts of the same category on each platform."
        action={
          <Button onClick={() => { setEditing(null); setShowForm((s) => !s); }}>
            {showForm ? "Close" : "+ New account"}
          </Button>
        }
      />

      {(showForm || editing) && (
        <AccountForm
          account={editing}
          onDone={() => { setShowForm(false); setEditing(null); }}
        />
      )}

      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No accounts yet" hint="Add your accounts (platform × category) so clips can be routed and scheduled." />
      ) : (
        <div className="space-y-5">
          {byCategory.map(([category, accts]) => (
            <div key={category}>
              <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                <span className="capitalize">{category}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  {accts.length} account{accts.length === 1 ? "" : "s"}
                </span>
              </div>
              <Card className="p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {accts.map((a) => (
                      <tr key={a.id} className="border-t first:border-t-0" style={{ borderColor: "var(--border)" }}>
                        <td className="p-3 w-28"><span className="text-xs px-2 py-0.5 rounded surface-2">{a.platform}</span></td>
                        <td className="p-3 font-medium">{a.handle}</td>
                        <td className="p-3 text-xs" style={{ color: "var(--muted)" }}>
                          {a.postsPerDay}/day · {a.activeStartHour}:00–{a.activeEndHour}:00 · {a.timezone}
                        </td>
                        <td className="p-3"><StatusBadge status={a.status} /></td>
                        <td className="p-3 text-right">
                          <Button variant="ghost" onClick={() => { setShowForm(false); setEditing(a); }}>Edit</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountForm({ account, onDone }: { account: SocialAccountDto | null; onDone: () => void }) {
  const isEdit = !!account;
  const [platform, setPlatform] = useState(account?.platform ?? "TIKTOK");
  const [handle, setHandle] = useState(account?.handle ?? "");
  const [category, setCategory] = useState(account?.category ?? "general");
  const [postsPerDay, setPostsPerDay] = useState(String(account?.postsPerDay ?? 10));
  const [startHour, setStartHour] = useState(String(account?.activeStartHour ?? 9));
  const [endHour, setEndHour] = useState(String(account?.activeEndHour ?? 21));
  const [timezone, setTimezone] = useState(
    account?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      category: category.trim().toLowerCase(),
      postsPerDay: Number(postsPerDay),
      activeStartHour: Number(startHour),
      activeEndHour: Number(endHour),
      timezone: timezone.trim(),
    };
    try {
      if (isEdit) {
        await apiSend(`/accounts/${account!.id}`, "PATCH", body);
      } else {
        await apiSend("/accounts", "POST", { platform, handle: handle.trim(), ...body });
      }
      await revalidateAll();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save account");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full px-3 py-2 rounded-lg surface-2 border outline-none text-sm";
  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid md:grid-cols-3 gap-4">
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)} className={field} disabled={isEdit}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Handle</label>
          <input required value={handle} onChange={(e) => setHandle(e.target.value)} className={field} placeholder="@myhandle" disabled={isEdit} />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Category</label>
          <input required value={category} onChange={(e) => setCategory(e.target.value)} className={field} placeholder="business" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Posts / day</label>
          <input type="number" min={1} max={96} value={postsPerDay} onChange={(e) => setPostsPerDay(e.target.value)} className={field} />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Active hours (start–end)</label>
          <div className="flex gap-2">
            <input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(e.target.value)} className={field} />
            <input type="number" min={0} max={23} value={endHour} onChange={(e) => setEndHour(e.target.value)} className={field} />
          </div>
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Timezone</label>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className={field} placeholder="UTC" />
        </div>
        {error && <p className="text-sm md:col-span-3" style={{ color: "var(--danger)" }}>{error}</p>}
        <div className="md:col-span-3 flex gap-2">
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : isEdit ? "Save changes" : "Add account"}</Button>
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
