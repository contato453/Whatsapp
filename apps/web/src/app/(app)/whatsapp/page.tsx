"use client";

import { useCallback, useEffect, useState } from "react";
import { Plug, PlugZap, Plus, QrCode, Smartphone, Trash2, Unplug } from "lucide-react";
import { RealtimeEvents, type ConnectionStatus } from "@zapdesk/shared";
import { api } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { formatDateTime, formatPhone } from "@/lib/utils";
import type { InstanceDto } from "@/lib/types";
import { Badge, Button, Card, Field, Input, Modal, Spinner, EmptyState } from "@/components/ui";

const STATUS_LABEL: Record<ConnectionStatus, { label: string; color: string }> = {
  disconnected: { label: "Desconectado", color: "#64748b" },
  connecting: { label: "Conectando...", color: "#d97706" },
  qr_required: { label: "Aguardando QR Code", color: "#d97706" },
  connected: { label: "Conectado", color: "#16a34a" },
  reconnecting: { label: "Reconectando...", color: "#d97706" },
  error: { label: "Erro", color: "#dc2626" },
};

export default function WhatsAppPage() {
  const socket = useSocket();
  const [instances, setInstances] = useState<InstanceDto[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [qrModal, setQrModal] = useState<{ instanceId: string; qrDataUrl: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<{ instances: InstanceDto[] }>("/whatsapp-instances").then((data) => setInstances(data.instances));
  }, []);

  useEffect(load, [load]);

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
      await api.post("/whatsapp-instances", { name: newName.trim() });
      setNewName("");
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
            <span className="w-36 shrink-0">Status</span>
            <span className="w-44 shrink-0">Última conexão</span>
            <span className="w-56 shrink-0 text-right">Ações</span>
          </div>
          <ul className="divide-y divide-slate-200">
            {instances.map((instance) => {
              const status = STATUS_LABEL[instance.status];
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
                  </div>

                  <div className="w-44 shrink-0">
                    {instance.phoneNumber ? (
                      <span className="font-mono text-sm text-slate-700">{formatPhone(instance.phoneNumber)}</span>
                    ) : (
                      <span className="text-sm text-slate-400">Não vinculado</span>
                    )}
                  </div>

                  <div className="w-36 shrink-0">
                    <Badge color={status.color}>{status.label}</Badge>
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
