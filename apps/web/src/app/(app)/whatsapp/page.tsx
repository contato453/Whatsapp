"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  DatabaseBackup,
  Plug,
  PlugZap,
  Plus,
  QrCode,
  Smartphone,
  Trash2,
  Unplug,
  UserCheck,
} from "lucide-react";
import {
  CONNECTION_STATUS_COLORS,
  CONNECTION_STATUS_LABELS,
  RealtimeEvents,
  type ConnectionStatus,
} from "@azvchat/shared";
import { api, ApiError, instanceBackupApi } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { formatDateTime, formatPhone } from "@/lib/utils";
import type { DepartmentDto, InstanceDto, UserDirectoryDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, EmptyState } from "@/components/ui";

export default function WhatsAppPage() {
  const socket = useSocket();
  const [instances, setInstances] = useState<InstanceDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDepartmentId, setNewDepartmentId] = useState("");
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [qrModal, setQrModal] = useState<{ instanceId: string; qrDataUrl: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Quem pode ser responsável padrão, por número. */
  const [assignees, setAssignees] = useState<Record<string, UserDirectoryDto[]>>({});
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    api.get<{ instances: InstanceDto[] }>("/whatsapp-instances").then((data) => {
      setInstances(data.instances);
      // Cada número tem sua própria lista: só quem o enxerga pode recebê-lo.
      for (const instance of data.instances) {
        api
          .get<{ users: UserDirectoryDto[] }>(`/whatsapp-instances/${instance.id}/assignees`)
          .then((result) =>
            setAssignees((current) => ({ ...current, [instance.id]: result.users })),
          )
          .catch(() => undefined);
      }
    });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    api
      .get<{ departments: DepartmentDto[] }>("/departments")
      .then((data) => setDepartments(data.departments))
      .catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onStatus = (payload: { instanceId: string; status: ConnectionStatus; phoneNumber?: string | null }) => {
      setInstances((current) =>
        current?.map((instance) =>
          instance.id === payload.instanceId
            ? {
                ...instance,
                status: payload.status,
                phoneNumber: payload.phoneNumber ?? instance.phoneNumber,
              }
            : instance,
        ) ?? null,
      );
      // QR lido com sucesso: fecha o modal automaticamente, sem reload.
      if (payload.status === "connected") {
        setQrModal((modal) => (modal?.instanceId === payload.instanceId ? null : modal));
      }
    };
    const onQr = (payload: { instanceId: string; qrDataUrl: string }) => {
      setQrModal((modal) =>
        modal?.instanceId === payload.instanceId ? { ...modal, qrDataUrl: payload.qrDataUrl } : modal,
      );
    };
    socket.on(RealtimeEvents.InstanceStatus, onStatus);
    socket.on(RealtimeEvents.InstanceQr, onQr);
    return () => {
      socket.off(RealtimeEvents.InstanceStatus, onStatus);
      socket.off(RealtimeEvents.InstanceQr, onQr);
    };
  }, [socket]);

  async function createInstance() {
    if (newName.trim().length < 2) return;
    setBusy("create");
    try {
      await api.post("/whatsapp-instances", {
        name: newName.trim(),
        departmentId: newDepartmentId || null,
      });
      setNewName("");
      setNewDepartmentId("");
      setCreating(false);
      load();
    } finally {
      setBusy(null);
    }
  }

  async function connect(instance: InstanceDto) {
    setBusy(instance.id);
    try {
      const result = await api.post<{ status: ConnectionStatus; qrDataUrl: string | null }>(
        `/whatsapp-instances/${instance.id}/connect`,
      );
      setQrModal({ instanceId: instance.id, qrDataUrl: result.qrDataUrl });
    } finally {
      setBusy(null);
    }
  }

  async function changeDepartment(instance: InstanceDto, departmentId: string) {
    setBusy(instance.id);
    try {
      await api.patch(`/whatsapp-instances/${instance.id}`, {
        departmentId: departmentId || null,
      });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function changeDefaultAssignee(instance: InstanceDto, userId: string) {
    setBusy(instance.id);
    setNotice(null);
    try {
      await api.patch(`/whatsapp-instances/${instance.id}`, {
        defaultAssigneeId: userId || null,
      });
      load();
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Não foi possível salvar o responsável",
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * O responsável padrão só age na mensagem que chega. As conversas que já
   * estão paradas sem dono precisam deste empurrão explícito.
   */
  async function applyDefaultAssignee(instance: InstanceDto) {
    const assignee = (assignees[instance.id] ?? []).find(
      (user) => user.id === instance.defaultAssigneeId,
    );
    const name = assignee?.name ?? "o responsável padrão";
    if (
      !window.confirm(
        `Atribuir a ${name} todas as conversas sem responsável de "${instance.name}"?`,
      )
    ) {
      return;
    }
    setBusy(instance.id);
    setNotice(null);
    try {
      const result = await api.post<{ assigned: number }>(
        `/whatsapp-instances/${instance.id}/apply-default-assignee`,
      );
      setNotice({
        tone: "ok",
        text:
          result.assigned === 0
            ? `Nenhuma conversa sem responsável em "${instance.name}".`
            : `${result.assigned} ${result.assigned === 1 ? "conversa atribuída" : "conversas atribuídas"} a ${name}.`,
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Não foi possível atribuir as conversas",
      });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Liga/desliga a marcação de backup. Ligar NÃO arquiva o que já existe
   * (para isso há a ação explícita de arquivar todas) e desligar não
   * desarquiva nada — dali em diante conversa nova nasce normal.
   */
  async function toggleBackup(instance: InstanceDto) {
    const enabling = !instance.isBackup;
    if (
      enabling &&
      !window.confirm(
        `Marcar "${instance.name}" como número de backup? Toda conversa NOVA nele já nasce arquivada (fora da Inbox e dos números). As conversas que já existem não mudam — use "Arquivar todas" se quiser arquivá-las também.`,
      )
    ) {
      return;
    }
    setBusy(instance.id);
    setNotice(null);
    try {
      await instanceBackupApi.setBackup(instance.id, enabling);
      load();
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Não foi possível salvar a marcação",
      });
    } finally {
      setBusy(null);
    }
  }

  /** Arquiva todas as conversas do número, dizendo quantas antes. */
  async function archiveAllConversations(instance: InstanceDto) {
    setBusy(instance.id);
    setNotice(null);
    try {
      const count = await instanceBackupApi.archivableCount(instance.id);
      if (count === 0) {
        setNotice({ tone: "ok", text: `Nenhuma conversa por arquivar em "${instance.name}".` });
        return;
      }
      if (
        !window.confirm(
          `Arquivar ${count} ${count === 1 ? "conversa" : "conversas"} de "${instance.name}"? Elas somem da Inbox e deixam de contar nos números do sistema. Nada é apagado.`,
        )
      ) {
        return;
      }
      const result = await instanceBackupApi.archiveAll(instance.id);
      setNotice({
        tone: "ok",
        text: `${result.archived} ${result.archived === 1 ? "conversa arquivada" : "conversas arquivadas"} em "${instance.name}".`,
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof ApiError ? err.message : "Não foi possível arquivar as conversas",
      });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(instance: InstanceDto) {
    setBusy(instance.id);
    try {
      await api.post(`/whatsapp-instances/${instance.id}/disconnect`);
      load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(instance: InstanceDto) {
    if (!window.confirm(`Excluir a instância "${instance.name}"? A sessão será encerrada.`)) return;
    setBusy(instance.id);
    try {
      await api.delete(`/whatsapp-instances/${instance.id}`);
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Números de WhatsApp</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> Adicionar WhatsApp
        </Button>
      </div>

      {notice && (
        <p
          className={`mb-4 text-sm ${notice.tone === "ok" ? "text-emerald-600" : "text-red-600"}`}
        >
          {notice.text}
        </p>
      )}

      {!instances ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : instances.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-12 w-12" />}
          title="Nenhum número conectado"
          description='Clique em "Adicionar WhatsApp" para criar a primeira instância e escanear o QR Code.'
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden items-center gap-4 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:flex">
            <span className="min-w-0 flex-1">Instância</span>
            <span className="w-44 shrink-0">Número</span>
            <span className="w-44 shrink-0">Departamento</span>
            <span className="w-52 shrink-0">Responsável padrão</span>
            <span className="w-28 shrink-0">Backup</span>
            <span className="w-36 shrink-0">Status</span>
            <span className="w-44 shrink-0">Última conexão</span>
            <span className="w-56 shrink-0 text-right">Ações</span>
          </div>
          <ul className="divide-y divide-slate-200">
            {instances.map((instance) => {
              const statusLabel = CONNECTION_STATUS_LABELS[instance.status];
              const statusColor = CONNECTION_STATUS_COLORS[instance.status];
              return (
                <li
                  key={instance.id}
                  className="flex flex-col gap-3 px-5 py-3.5 transition-colors hover:bg-slate-50 lg:flex-row lg:items-center lg:gap-4"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                      <Smartphone className="h-4 w-4" />
                    </div>
                    <p className="truncate font-semibold text-slate-900">{instance.name}</p>
                    {/* Selo ao lado do nome: explica por que este número não
                        aparece nas conversas nem nos números do dashboard. */}
                    {instance.isBackup && (
                      <Badge className="shrink-0 bg-slate-200 text-slate-600">
                        <DatabaseBackup className="h-3 w-3" /> Backup
                      </Badge>
                    )}
                  </div>

                  <div className="w-44 shrink-0">
                    {instance.phoneNumber ? (
                      <span className="font-mono text-sm text-slate-700">{formatPhone(instance.phoneNumber)}</span>
                    ) : (
                      <span className="text-sm text-slate-400">Não vinculado</span>
                    )}
                  </div>

                  <div className="w-44 shrink-0">
                    <select
                      className="w-full max-w-[11rem] rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      value={instance.departmentId ?? ""}
                      disabled={busy === instance.id}
                      onChange={(event) => void changeDepartment(instance, event.target.value)}
                      title="Departamento em que as conversas deste número entram"
                    >
                      <option value="">Sem departamento</option>
                      {departments.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex w-52 shrink-0 items-center gap-1">
                    <select
                      className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                      value={instance.defaultAssigneeId ?? ""}
                      disabled={busy === instance.id}
                      onChange={(event) => void changeDefaultAssignee(instance, event.target.value)}
                      title="Quem assume as conversas deste número que chegam sem responsável"
                    >
                      <option value="">Sem responsável padrão</option>
                      {(assignees[instance.id] ?? []).map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.name}
                        </option>
                      ))}
                    </select>
                    {instance.defaultAssigneeId && (
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-50"
                        disabled={busy === instance.id}
                        onClick={() => void applyDefaultAssignee(instance)}
                        title="Atribuir também as conversas que já estão sem responsável"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex w-28 shrink-0 items-center gap-1">
                    {/* Papel mínimo: supervisor — o mesmo requireRole da
                        rota. Esta tela inteira já é de supervisor no NAV. */}
                    <label
                      className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600"
                      title="Ligado, toda conversa nova deste número já nasce arquivada"
                    >
                      <input
                        type="checkbox"
                        checked={instance.isBackup}
                        disabled={busy === instance.id}
                        onChange={() => void toggleBackup(instance)}
                        className="h-3.5 w-3.5 accent-slate-600"
                      />
                      Backup
                    </label>
                    {instance.isBackup && (
                      <button
                        type="button"
                        className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-colors hover:bg-slate-100 disabled:opacity-50"
                        disabled={busy === instance.id}
                        onClick={() => void archiveAllConversations(instance)}
                        title="Arquivar todas as conversas deste número (diz quantas antes de executar)"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="w-36 shrink-0">
                    <Badge color={statusColor}>{statusLabel}</Badge>
                  </div>

                  <div className="w-44 shrink-0 text-xs text-slate-400">
                    <span className="lg:hidden">Última conexão: </span>
                    {instance.lastConnectionAt ? formatDateTime(instance.lastConnectionAt) : "nunca"}
                  </div>

                  <div className="flex w-56 shrink-0 flex-wrap gap-2 lg:justify-end">
                    {instance.status === "connected" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === instance.id}
                        onClick={() => disconnect(instance)}
                      >
                        <Unplug className="h-3.5 w-3.5" /> Desconectar
                      </Button>
                    ) : instance.status === "qr_required" ? (
                      <Button size="sm" disabled={busy === instance.id} onClick={() => connect(instance)}>
                        <QrCode className="h-3.5 w-3.5" /> Ver QR Code
                      </Button>
                    ) : (
                      <Button size="sm" disabled={busy === instance.id} onClick={() => connect(instance)}>
                        <PlugZap className="h-3.5 w-3.5" /> Conectar
                      </Button>
                    )}
                    <Button size="sm" variant="danger" disabled={busy === instance.id} onClick={() => remove(instance)}>
                      <Trash2 className="h-3.5 w-3.5" /> Excluir
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Adicionar WhatsApp">
        <div className="space-y-4">
          <Field label="Nome da instância">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Ex.: WhatsApp Contábil"
              autoFocus
            />
          </Field>
          <Field label="Departamento padrão">
            <select
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={newDepartmentId}
              onChange={(event) => setNewDepartmentId(event.target.value)}
            >
              <option value="">Sem departamento</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs text-slate-500">
            As conversas que chegarem neste número entram nesse departamento, e só quem
            atua nele passa a enxergá-las.
          </p>
          <p className="text-xs text-slate-500">
            Depois de criar, clique em Conectar para gerar o QR Code e escanear com o celular
            (WhatsApp → Dispositivos conectados).
          </p>
          <Button className="w-full" onClick={createInstance} disabled={busy === "create"}>
            Criar instância
          </Button>
        </div>
      </Modal>

      <Modal
        open={qrModal != null}
        onClose={() => setQrModal(null)}
        title="Conectar WhatsApp"
      >
        <div className="flex flex-col items-center gap-4 py-2">
          {qrModal?.qrDataUrl ? (
            <>
              <img
                src={qrModal.qrDataUrl}
                alt="QR Code de conexão"
                className="h-64 w-64 rounded-lg border border-slate-200"
              />
              <p className="max-w-xs text-center text-xs text-slate-500">
                Abra o WhatsApp no celular → Configurações → Dispositivos conectados →
                Conectar dispositivo, e escaneie o código. Ele é atualizado automaticamente.
              </p>
            </>
          ) : (
            <>
              <div className="flex h-64 w-64 items-center justify-center rounded-lg border border-dashed border-slate-300">
                <div className="flex flex-col items-center gap-3">
                  <Spinner className="h-8 w-8" />
                  <p className="text-xs text-slate-400">Gerando QR Code...</p>
                </div>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-slate-400">
                <Plug className="h-3.5 w-3.5" /> Estabelecendo sessão com o WhatsApp...
              </p>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
