"use client";

import { useEffect, useState } from "react";
import {
  Inbox as InboxIcon,
  MessageCircleMore,
  MessagesSquare,
  Smartphone,
  UserX,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api";
import type { DashboardStatsDto } from "@/lib/types";
import { Card, Spinner } from "@/components/ui";

function Stat({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <div
        className="flex h-11 w-11 items-center justify-center rounded-xl"
        style={{ backgroundColor: `${accent ?? "#6366f1"}1a`, color: accent ?? "#6366f1" }}
      >
        {icon}
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        <p className="text-xs font-medium text-slate-500">{label}</p>
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<DashboardStatsDto>("/dashboard/stats")
      .then(setStats)
      .catch((err) => setError(err instanceof Error ? err.message : "Erro"));
    const interval = setInterval(() => {
      api.get<DashboardStatsDto>("/dashboard/stats").then(setStats).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return <p className="p-8 text-sm text-red-600">{error}</p>;
  }
  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Dashboard</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="WhatsApps conectados"
          value={stats.instancesConnected}
          icon={<Smartphone className="h-5 w-5" />}
          accent="#16a34a"
        />
        <Stat
          label="WhatsApps desconectados"
          value={stats.instancesDisconnected}
          icon={<Smartphone className="h-5 w-5" />}
          accent="#dc2626"
        />
        <Stat
          label="Conversas abertas"
          value={stats.conversationsOpen}
          icon={<InboxIcon className="h-5 w-5" />}
        />
        <Stat
          label="Aguardando atendimento"
          value={stats.conversationsWaiting}
          icon={<Clock className="h-5 w-5" />}
          accent="#d97706"
        />
        <Stat
          label="Sem responsável"
          value={stats.conversationsUnassigned}
          icon={<UserX className="h-5 w-5" />}
          accent="#dc2626"
        />
        <Stat
          label="Mensagens recebidas hoje"
          value={stats.messagesReceivedToday}
          icon={<MessagesSquare className="h-5 w-5" />}
        />
        <Stat
          label="Mensagens enviadas hoje"
          value={stats.messagesSentToday}
          icon={<MessageCircleMore className="h-5 w-5" />}
          accent="#0891b2"
        />
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Atendimentos por departamento
      </h2>
      <Card className="divide-y divide-slate-100">
        {stats.conversationsByDepartment.length === 0 && (
          <p className="p-5 text-sm text-slate-400">Nenhum atendimento em andamento.</p>
        )}
        {stats.conversationsByDepartment.map((entry) => (
          <div key={entry.departmentId ?? "none"} className="flex items-center justify-between px-5 py-3">
            <span className="text-sm text-slate-700">{entry.departmentName}</span>
            <span className="text-sm font-semibold text-slate-900">{entry.count}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
