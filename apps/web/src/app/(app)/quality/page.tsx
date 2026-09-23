"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { api, qualityApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { QualityRunDto, QualitySettingsDto, UserDirectoryDto } from "@/lib/types";
import { Card, EmptyState, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import { AgentView } from "@/components/quality/agent-view";
import { EvaluationList } from "@/components/quality/evaluation-list";
import { NewAnalysis } from "@/components/quality/new-analysis";
import { QualitySettingsCard } from "@/components/quality/quality-settings-card";
import { RunList } from "@/components/quality/run-list";

/**
 * QUALITY — avaliação do atendimento pela IA.
 *
 * SIGILO: esta tela é do administrador, e de mais ninguém. A guarda de verdade
 * é a da API, que responde 404 (e não 403) para qualquer outro papel — negar com
 * "sem permissão" confirmaria que o módulo existe. A checagem aqui é
 * conveniência, como em toda tela da casa.
 *
 * A avaliação não fica no `inbox-shell.tsx`, nem encosta nele: aquele arquivo já
 * passa das mil linhas, e a lista de conversas do atendimento não pode ganhar
 * nem um pixel de nota, sob pena de o atendente descobrir que existe avaliação.
 */

type Aba = "nova" | "analises" | "avaliacoes" | "atendentes" | "config";

const ABAS: Array<{ id: Aba; label: string }> = [
  { id: "nova", label: "Nova análise" },
  { id: "analises", label: "Análises" },
  { id: "avaliacoes", label: "Avaliações" },
  { id: "atendentes", label: "Por atendente" },
  { id: "config", label: "Configurações" },
];

export default function QualityPage() {
  const { user } = useAuth();
  const [aba, setAba] = useState<Aba>("nova");
  const [settings, setSettings] = useState<QualitySettingsDto | null>(null);
  const [users, setUsers] = useState<UserDirectoryDto[]>([]);
  const [disponivel, setDisponivel] = useState<{ enabled: boolean; reason: string | null } | null>(null);
  // Muda quando um disparo novo acontece: é o que faz a lista de análises
  // recarregar sem a tela inteira remontar.
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (user?.role !== "admin") return;
    void qualityApi.availability().then(setDisponivel).catch(() => setDisponivel({ enabled: false, reason: null }));
    void qualityApi.settings().then(setSettings).catch(() => undefined);
    void api
      .get<{ users: UserDirectoryDto[] }>("/users")
      .then((data) => setUsers(data.users))
      .catch(() => undefined);
  }, [user?.role]);

  if (user && user.role !== "admin") {
    return (
      <div className="p-6">
        <EmptyState title="Área restrita" description="Esta tela é de administração do sistema." />
      </div>
    );
  }

  if (!disponivel) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!disponivel.enabled) {
    return (
      <div className="p-6">
        <Card className="p-5">
          <EmptyState
            icon={<Gauge className="h-8 w-8" />}
            title="Módulo de qualidade desligado"
            description={
              disponivel.reason ??
              "O módulo depende da inteligência artificial, que ainda não está configurada nesta organização."
            }
          />
        </Card>
      </div>
    );
  }

  function aoDisparar(_run: QualityRunDto): void {
    // Depois de disparar, a tela leva o administrador para onde o estado
    // aparece: a lista de análises, que acompanha em tempo real.
    setAba("analises");
    setRefreshToken((atual) => atual + 1);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
            <Gauge className="h-5 w-5 text-brand-600" /> Quality
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            A inteligência artificial lê as conversas do período escolhido, dá nota ao atendente, classifica
            o assunto e sugere um plano de ação. Só o administrador enxerga esta área.
          </p>
        </header>

        <nav className="mt-5 flex flex-wrap gap-1 border-b border-slate-200">
          {ABAS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setAba(item.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                aba === item.id
                  ? "border-brand-550 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-700",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="mt-5 pb-10">
          {aba === "nova" ? <NewAnalysis settings={settings} onStarted={aoDisparar} /> : null}
          {aba === "analises" ? <RunList refreshToken={refreshToken} /> : null}
          {aba === "avaliacoes" ? <EvaluationList users={users} /> : null}
          {aba === "atendentes" ? <AgentView /> : null}
          {aba === "config" ? (
            settings ? (
              <QualitySettingsCard settings={settings} onSaved={setSettings} />
            ) : (
              <Spinner className="mx-auto mt-10 h-6 w-6" />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
