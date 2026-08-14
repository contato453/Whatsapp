"use client";

import { useEffect, useState } from "react";
import { KeyRound, Save } from "lucide-react";
import { USER_ROLE_LABELS } from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { API_URL, ApiError, api } from "@/lib/api";
import type { UserDto } from "@/lib/types";
import { Button, Card, Field, Input } from "@/components/ui";

export default function SettingsPage() {
  const { user, setSession } = useAuth();

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Configurações</h1>
      <div className="max-w-xl space-y-4">
        {user && <ProfileCard user={user} onSaved={setSession} />}
        <PasswordCard />
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Sistema
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">API</dt>
              <dd className="font-mono text-xs text-slate-700">{API_URL}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Versão</dt>
              <dd className="font-medium text-slate-900">0.1.0 (MVP)</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

/**
 * Nome e assinatura são do próprio usuário. E-mail e papel aparecem só para
 * leitura: mudar credencial de entrada ou nível de acesso é ato de
 * administração, e a API recusa mesmo que a tela tentasse.
 */
function ProfileCard({
  user,
  onSaved,
}: {
  user: UserDto;
  onSaved: (token: string, user: UserDto) => void;
}) {
  const [name, setName] = useState(user.name);
  const [signMessages, setSignMessages] = useState(user.signMessages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(user.name);
    setSignMessages(user.signMessages);
  }, [user.name, user.signMessages]);

  const dirty = name.trim() !== user.name || signMessages !== user.signMessages;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api.patch<{ token: string; user: UserDto }>("/auth/me", {
        name: name.trim(),
        signMessages,
      });
      onSaved(data.token, data.user);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Minha conta</h2>

      <Field label="Nome">
        <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
      </Field>

      <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          checked={signMessages}
          onChange={(event) => setSignMessages(event.target.checked)}
        />
        <span>
          Assinar mensagens com o nome
          <span className="mt-0.5 block text-xs text-slate-400">
            O texto sai como &ldquo;{name || "Seu nome"}:&rdquo; na primeira linha, para o cliente
            saber quem está atendendo.
          </span>
        </span>
      </label>

      <dl className="space-y-2 border-t border-slate-100 pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">E-mail</dt>
          <dd className="font-medium text-slate-900">{user.email}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-slate-500">Papel</dt>
          <dd className="font-medium text-slate-900">{USER_ROLE_LABELS[user.role]}</dd>
        </div>
      </dl>
      <p className="text-xs text-slate-400">
        E-mail e papel são alterados por um administrador, em Usuários.
      </p>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !dirty && <p className="text-sm text-emerald-600">Perfil atualizado.</p>}

      <Button disabled={busy || !dirty || name.trim().length < 2} onClick={() => void save()}>
        <Save className="h-4 w-4" /> Salvar
      </Button>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // A conferência da nova senha é local: não faz sentido ir à API para saber
  // que a pessoa digitou diferente duas vezes.
  const mismatch = confirmation.length > 0 && next !== confirmation;
  const ready = current.length > 0 && next.length >= 6 && next === confirmation;

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      setCurrent("");
      setNext("");
      setConfirmation("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível alterar a senha");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Senha</h2>

      <Field label="Senha atual">
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      </Field>
      <Field label="Nova senha">
        <Input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          placeholder="No mínimo 6 caracteres"
        />
      </Field>
      <Field label="Repita a nova senha">
        <Input
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </Field>

      {mismatch && <p className="text-sm text-amber-600">As duas senhas não conferem.</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {done && <p className="text-sm text-emerald-600">Senha alterada.</p>}

      <Button disabled={busy || !ready} onClick={() => void submit()}>
        <KeyRound className="h-4 w-4" /> Alterar senha
      </Button>
    </Card>
  );
}
