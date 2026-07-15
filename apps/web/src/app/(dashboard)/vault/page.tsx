"use client";
import { useMemo, useState } from "react";
import { apiGet, apiSend, revalidateAll, useAccounts, useCategories, type SocialAccountDto } from "@/lib/api";
import { Button, Card, EmptyState, PageHeader, Spinner } from "@/components/ui";

const PLATFORMS = ["YOUTUBE", "TIKTOK", "FACEBOOK", "INSTAGRAM"] as const;
const PLATFORM_LABEL: Record<string, string> = {
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
};
const PLATFORM_ORDER = ["YOUTUBE", "TIKTOK", "FACEBOOK", "INSTAGRAM"];

export default function VaultPage() {
  const { data, isLoading } = useAccounts();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SocialAccountDto | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, SocialAccountDto[]>();
    for (const a of data ?? []) {
      if (!m.has(a.platform)) m.set(a.platform, []);
      m.get(a.platform)!.push(a);
    }
    const known = PLATFORM_ORDER.filter((p) => m.has(p));
    const rest = [...m.keys()].filter((p) => !PLATFORM_ORDER.includes(p));
    return [...known, ...rest].map((p) => [p, m.get(p)!] as const);
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Vault"
        subtitle="Login details for your posting accounts, kept in one place."
        action={
          <Button onClick={() => { setEditing(null); setShowForm((s) => !s); }}>
            {showForm ? "Close" : "+ New account"}
          </Button>
        }
      />

      <Card className="mb-6 py-3">
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          🔒 Passwords are encrypted at rest and only shown when you click <b>Reveal</b>. The
          decryption key lives on this server, so treat this as convenience storage — use unique
          passwords and 2-factor auth, and a dedicated password manager for anything critical.
        </p>
      </Card>

      {(showForm || editing) && (
        <AccountForm account={editing} onDone={() => { setShowForm(false); setEditing(null); }} />
      )}

      {isLoading ? (
        <Spinner />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No accounts yet" hint="Add an account to store its login details." />
      ) : (
        <div className="space-y-5">
          {groups.map(([platform, accts]) => (
            <div key={platform}>
              <div className="text-sm font-semibold mb-2 flex items-center gap-2">
                {PLATFORM_LABEL[platform] ?? platform}
                <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>
                  {accts.length} account{accts.length === 1 ? "" : "s"}
                </span>
              </div>
              <Card className="p-0 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs" style={{ color: "var(--muted)" }}>
                      <th className="p-3 font-medium">Handle</th>
                      <th className="p-3 font-medium">Username</th>
                      <th className="p-3 font-medium">Password</th>
                      <th className="p-3 font-medium">Channel</th>
                      <th className="p-3 font-medium">Category</th>
                      <th className="p-3"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accts.map((a) => (
                      <tr key={a.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                        <td className="p-3 font-medium">{a.handle}</td>
                        <td className="p-3" style={{ color: a.username ? "var(--text)" : "var(--muted)" }}>
                          {a.username ?? "—"}
                        </td>
                        <td className="p-3"><PasswordCell account={a} /></td>
                        <td className="p-3" style={{ color: "var(--muted)" }}>{a.channelId ?? "—"}</td>
                        <td className="p-3 capitalize" style={{ color: "var(--muted)" }}>{a.category}</td>
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

function PasswordCell({ account }: { account: SocialAccountDto }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!account.hasPassword) return <span style={{ color: "var(--muted)" }}>—</span>;

  async function reveal() {
    setBusy(true);
    try {
      const r = await apiGet<{ password: string | null }>(`/accounts/${account.id}/reveal`);
      setValue(r.password ?? "");
    } finally {
      setBusy(false);
    }
  }

  if (value === null) {
    return (
      <button onClick={reveal} disabled={busy} className="text-xs px-2 py-1 rounded surface-2 border" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        {busy ? "…" : "•••• Reveal"}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <code className="text-xs">{value}</code>
      <button onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="text-xs" style={{ color: "var(--primary)" }}>
        {copied ? "copied" : "copy"}
      </button>
      <button onClick={() => setValue(null)} className="text-xs" style={{ color: "var(--muted)" }}>hide</button>
    </span>
  );
}

function AccountForm({ account, onDone }: { account: SocialAccountDto | null; onDone: () => void }) {
  const isEdit = !!account;
  const { data: cats } = useCategories();
  const categoryOptions = (cats ?? []).map((c) => c.name);
  const [platform, setPlatform] = useState(account?.platform ?? "YOUTUBE");
  const [handle, setHandle] = useState(account?.handle ?? "");
  const [username, setUsername] = useState(account?.username ?? "");
  const [password, setPassword] = useState("");
  const [channelId, setChannelId] = useState(account?.channelId ?? "");
  const [category, setCategory] = useState(account?.category ?? categoryOptions[0] ?? "general");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Only send password if the user typed one (blank keeps the existing value).
    const creds = {
      username: username.trim() || undefined,
      ...(password ? { password } : {}),
      channelId: channelId.trim() || undefined,
      category: category.trim().toLowerCase(),
    };
    try {
      if (isEdit) {
        await apiSend(`/accounts/${account!.id}`, "PATCH", creds);
      } else {
        await apiSend("/accounts", "POST", { platform, handle: handle.trim(), ...creds });
      }
      await revalidateAll();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
            {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Handle</label>
          <input required value={handle} onChange={(e) => setHandle(e.target.value)} className={field} placeholder="@myhandle" disabled={isEdit} />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Category</label>
          {categoryOptions.length > 0 ? (
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${field} capitalize`}>
              {!categoryOptions.includes(category) && category && <option value={category}>{category}</option>}
              {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input value={category} onChange={(e) => setCategory(e.target.value)} className={field} placeholder="comedy" />
          )}
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Username / email</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={field} placeholder="login@example.com" autoComplete="off" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            Password {isEdit && <span style={{ color: "var(--muted)" }}>(blank = keep)</span>}
          </label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} placeholder={isEdit ? "••••••••" : ""} autoComplete="new-password" />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Channel name / ID (optional)</label>
          <input value={channelId} onChange={(e) => setChannelId(e.target.value)} className={field} placeholder="UC… or page name" />
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
