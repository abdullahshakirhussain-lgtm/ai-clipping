"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@clipfactory.local");
  const [password, setPassword] = useState("admin1234");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await signIn.email({ email, password });
    setLoading(false);
    if (res.error) {
      setError(res.error.message ?? "Sign-in failed");
      return;
    }
    router.push("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6">
          <span className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-white" style={{ background: "var(--primary)" }}>C</span>
          <h1 className="text-xl font-semibold">Clip Factory</h1>
        </div>
        <label className="block text-sm mb-1" style={{ color: "var(--muted)" }}>Email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          className="w-full mb-4 px-3 py-2 rounded-lg surface-2 border outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        <label className="block text-sm mb-1" style={{ color: "var(--muted)" }}>Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          className="w-full mb-4 px-3 py-2 rounded-lg surface-2 border outline-none"
          style={{ borderColor: "var(--border)" }}
        />
        {error && <p className="text-sm mb-3" style={{ color: "var(--danger)" }}>{error}</p>}
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-xs mt-4 text-center" style={{ color: "var(--muted)" }}>
          Dev credentials are prefilled. Change them in production.
        </p>
      </form>
    </div>
  );
}
