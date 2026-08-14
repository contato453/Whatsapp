"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import { Button, Card, Field, Input } from "@/components/ui";
import { LogoMark, LogoWordmark } from "@/components/logo";

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha no login");
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* Card branco: marca na versão colorida. */}
          <LogoMark className="h-12 w-12" />
          <h1>
            <LogoWordmark className="text-2xl" />
          </h1>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            Conecta · Atende · Resolve
          </p>
          <p className="text-sm text-slate-500">Central de atendimento WhatsApp</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="E-mail">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="voce@empresa.com.br"
              autoComplete="email"
              required
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Entrando..." : "Entrar"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
