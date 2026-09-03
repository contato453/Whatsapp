"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, KeyRound, Play, Save } from "lucide-react";
import {
  NOTIFICATION_SOUNDS,
  NOTIFICATION_SOUND_DESCRIPTIONS,
  NOTIFICATION_SOUND_LABELS,
  NOTIFICATION_VOLUMES,
  NOTIFICATION_VOLUME_LABELS,
  USER_ROLE_LABELS,
  type NotificationSound,
  type NotificationVolume,
} from "@azvchat/shared";
import { useAuth } from "@/lib/auth-context";
import { API_URL, ApiError, api, invalidateUserAvatar } from "@/lib/api";
import { previewNotificationSound } from "@/lib/notification-sound";
import type { UserDto } from "@/lib/types";
import { Button, Card, Field, Input } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { AvatarCropper } from "@/components/avatar-cropper";
import { IntegrationTokensCard } from "@/components/settings/integration-tokens";
import { AzevedoOsHealthCard } from "@/components/settings/azevedo-os-health";

export default function SettingsPage() {
  const { user, setSession, setUser } = useAuth();

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Configurações</h1>
      <div className="max-w-xl space-y-4">
        {user && <AvatarCard user={user} onChanged={setUser} />}
        {user && <ProfileCard user={user} onSaved={setSession} />}
        {user && <NotificationsCard user={user} onSaved={setSession} />}
        <PasswordCard />
        {/* Só admin administra tokens de máquina — a API recusa de novo. */}
        {user?.role === "admin" && <IntegrationTokensCard />}
        {/* Idem para a saúde da integração com o Azevedo-OS. */}
        {user?.role === "admin" && <AzevedoOsHealthCard />}
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
/**
 * Foto de perfil interna: aparece só dentro do sistema, para a equipe se
 * reconhecer. Não altera a foto de nenhum número de WhatsApp.
 */
function AvatarCard({
  user,
  onChanged,
}: {
  user: UserDto;
  onChanged: (user: UserDto) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function upload(blob: Blob) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", blob, "avatar.jpg");
      const data = await api.postForm<{ user: UserDto }>("/auth/me/avatar", form);
      invalidateUserAvatar(user.id);
      onChanged(data.user);
      setFile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível enviar a foto");
    } finally {
      setBusy(false);
    }
  }

  async function removePhoto() {
    if (!window.confirm("Remover sua foto de perfil?")) return;
    setBusy(true);
    try {
      const data = await api.delete<{ user: UserDto }>("/auth/me/avatar");
      invalidateUserAvatar(user.id);
      onChanged(data.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível remover a foto");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Foto</h2>
      <div className="flex items-center gap-4">
        <UserAvatar userId={user.id} name={user.name} hasAvatar={user.hasAvatar} size="lg" />
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Camera className="h-4 w-4" /> {user.hasAvatar ? "Trocar foto" : "Enviar foto"}
            </Button>
            {user.hasAvatar && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void removePhoto()}>
                Remover
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Aparece apenas dentro do sistema. Não tem relação com a foto dos números de WhatsApp.
          </p>
        </div>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0] ?? null;
          setFile(chosen);
          // Permite escolher o mesmo arquivo de novo depois de cancelar.
          event.target.value = "";
        }}
      />
      <AvatarCropper file={file} onCancel={() => setFile(null)} onConfirm={upload} />
    </Card>
  );
}

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
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
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

/**
 * Som de mensagem recebida. Preferência pessoal, gravada pelo mesmo
 * `PATCH /auth/me` do nome e da assinatura.
 *
 * Trocar aqui vale para esta aba na hora e para as outras no próximo
 * carregamento delas — não há sincronização entre abas nem entre
 * dispositivos, e não faria diferença prática ter.
 */
function NotificationsCard({
  user,
  onSaved,
}: {
  user: UserDto;
  onSaved: (token: string, user: UserDto) => void;
}) {
  const [sound, setSound] = useState<NotificationSound>(user.notificationSound);
  const [volume, setVolume] = useState<NotificationVolume>(user.notificationVolume);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSound(user.notificationSound);
    setVolume(user.notificationVolume);
  }, [user.notificationSound, user.notificationVolume]);

  const muted = sound === "none";
  const dirty = sound !== user.notificationSound || volume !== user.notificationVolume;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const data = await api.patch<{ token: string; user: UserDto }>("/auth/me", {
        notificationSound: sound,
        notificationVolume: volume,
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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Notificações
      </h2>
      <p className="text-xs text-slate-400">
        Toca quando chega mensagem de cliente. Fica em silêncio quando a conversa já está
        aberta na sua frente.
      </p>

      <Field label="Som">
        <div className="space-y-1.5">
          {NOTIFICATION_SOUNDS.map((option) => (
            <div
              key={option}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2"
            >
              <input
                type="radio"
                id={`notification-sound-${option}`}
                name="notification-sound"
                className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600"
                checked={sound === option}
                onChange={() => setSound(option)}
              />
              <label
                htmlFor={`notification-sound-${option}`}
                className="flex-1 cursor-pointer text-sm text-slate-700"
              >
                {NOTIFICATION_SOUND_LABELS[option]}
                <span className="mt-0.5 block text-xs text-slate-400">
                  {NOTIFICATION_SOUND_DESCRIPTIONS[option]}
                </span>
              </label>
              {/* "Nenhum" não tem o que ouvir; o botão fica visível e desligado
                  para a linha não parecer quebrada. */}
              <Button
                size="sm"
                variant="outline"
                disabled={option === "none"}
                aria-label={`Ouvir ${NOTIFICATION_SOUND_LABELS[option]}`}
                onClick={() => previewNotificationSound(option, volume)}
              >
                <Play className="h-3.5 w-3.5" /> Ouvir
              </Button>
            </div>
          ))}
        </div>
      </Field>

      <Field label="Volume">
        <div className="flex gap-2">
          {NOTIFICATION_VOLUMES.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={volume === option ? "primary" : "outline"}
              disabled={muted}
              onClick={() => {
                setVolume(option);
                // Preview no volume escolhido: é o único jeito de comparar.
                previewNotificationSound(sound, option);
              }}
            >
              {NOTIFICATION_VOLUME_LABELS[option]}
            </Button>
          ))}
        </div>
      </Field>
      {muted && (
        <p className="text-xs text-slate-400">
          Com o som em &ldquo;Nenhum&rdquo;, o volume não se aplica.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {saved && !dirty && <p className="text-sm text-emerald-600">Preferências salvas.</p>}

      <Button disabled={busy || !dirty} onClick={() => void save()}>
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
