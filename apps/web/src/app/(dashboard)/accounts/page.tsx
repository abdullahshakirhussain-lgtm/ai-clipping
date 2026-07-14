"use client";
import { useMemo, useState } from "react";
import { apiSend, revalidateAll, useAccounts, useCategories, type CategoryDto, type SocialAccountDto } from "@/lib/api";
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

      <CategoriesPanel />

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
  const { data: categories } = useCategories();
  const [platform, setPlatform] = useState(account?.platform ?? "TIKTOK");
  const [handle, setHandle] = useState(account?.handle ?? "");
  const [category, setCategory] = useState(account?.category ?? "general");
  const categoryNames = categories?.map((c) => c.name) ?? [];
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
          {categoryNames.length > 0 ? (
            <select required value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} capitalize`}>
              {!categoryNames.includes(category) && category && <option value={category}>{category}</option>}
              {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input required value={category} onChange={(e) => setCategory(e.target.value)} className={field} placeholder="business" />
          )}
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

/** Central category registry: the option list assigned to accounts/videos/clips. */
function CategoriesPanel() {
  const { data: categories } = useCategories();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await apiSend("/categories", "POST", { name: n });
      setName("");
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">Categories</h2>
        <span className="text-xs" style={{ color: "var(--muted)" }}>Define once — assign to accounts, videos & clips</span>
      </div>
      <div className="flex gap-2 my-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
          placeholder="new category (e.g. comedy)"
          className="flex-1 px-3 py-2 rounded-lg surface-2 border outline-none text-sm"
          style={{ borderColor: "var(--border)" }}
        />
        <Button onClick={add} disabled={busy || !name.trim()}>Add</Button>
      </div>
      {categories && categories.length > 0 ? (
        <div className="flex flex-col gap-1">
          {categories.map((c) => <CategoryRow key={c.id} cat={c} />)}
        </div>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>No categories yet — add one above, then assign it to your accounts.</p>
      )}
    </Card>
  );
}

function CategoryRow({ cat }: { cat: CategoryDto }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [busy, setBusy] = useState(false);
  const inUse = cat.accountCount + cat.clipCount;

  async function save() {
    const n = name.trim();
    if (!n || n === cat.name) { setEditing(false); return; }
    setBusy(true);
    try {
      await apiSend(`/categories/${cat.id}`, "PATCH", { name: n });
      setEditing(false);
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (inUse > 0 && !window.confirm(
      `"${cat.name}" is used by ${cat.accountCount} account(s) and ${cat.clipCount} clip(s). Remove it as an option? Existing items keep their category.`,
    )) return;
    setBusy(true);
    try {
      await apiSend(`/categories/${cat.id}`, "DELETE");
      await revalidateAll();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 py-1.5 px-2.5 rounded-lg surface-2">
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void save(); }
            if (e.key === "Escape") { setName(cat.name); setEditing(false); }
          }}
          className="px-2 py-1 rounded surface border text-sm"
          style={{ borderColor: "var(--border)" }}
        />
      ) : (
        <span className="capitalize font-medium text-sm">{cat.name}</span>
      )}
      <span className="text-xs" style={{ color: "var(--muted)" }}>
        {cat.accountCount} acct · {cat.clipCount} clips
      </span>
      <div className="ml-auto flex items-center gap-2 text-xs">
        {editing ? (
          <>
            <button onClick={save} disabled={busy} style={{ color: "var(--primary)" }}>Save</button>
            <button onClick={() => { setName(cat.name); setEditing(false); }} style={{ color: "var(--muted)" }}>Cancel</button>
          </>
        ) : (
          <button onClick={() => setEditing(true)} style={{ color: "var(--muted)" }}>Rename</button>
        )}
        <button onClick={remove} disabled={busy} style={{ color: "var(--danger)" }}>Delete</button>
      </div>
    </div>
  );
}
