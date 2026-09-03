"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AzevedoOsHealthDto } from "@azvchat/shared";
import { ApiError, azevedoOsApi } from "@/lib/api";
import { Badge, Button, Card, Spinner } from "@/components/ui";

/**
 * Saúde da integração com o Azevedo-OS — só admin (a tela de Configurações
 * renderiza condicionalmente, e a API recusa de novo com `requireRole("admin")`).
 *
 * Item C da correção do incidente de 03/09/2026: até então o defeito só
 * aparecia para quem abria o modal de vínculo, no meio do atendimento. Este
 * card responde de propósito as três perguntas que a seção 15 do CLAUDE.md
 * descreve: a configuração está presente, o portal respondeu na última
 * checagem e quando foi a última consulta que de fato funcionou.
 *
 * Não carrega sozinho ao entrar na tela: "Checar agora" faz uma consulta
 * AO VIVO no Azevedo-OS (ver a rota), então fica sob clique — não é dado
 * que precise estar sempre atualizado na tela de Configurações.
 */
export function AzevedoOsHealthCard() {
  const [health, setHealth] = useState<AzevedoOsHealthDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedOnce, setCheckedOnce] = useState(false);

  async function verificar() {
    setLoading(true);
    setError(null);
    try {
      setHealth(await azevedoOsApi.health());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível checar a integração");
    } finally {
      setLoading(false);
      setCheckedOnce(true);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Integração Azevedo-OS
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Leitura do cadastro empresarial usada no card &ldquo;Cliente Azevedo-OS&rdquo; da
            Inbox.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void verificar()}>
          <RefreshCw className="h-3.5 w-3.5" /> Checar agora
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-4">
          <Spinner className="h-5 w-5" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !checkedOnce ? (
        <p className="text-xs text-slate-400">
          Clique em &ldquo;Checar agora&rdquo; para consultar a configuração e testar o portal
          ao vivo.
        </p>
      ) : (
        health && (
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Configuração</dt>
              <dd>
                {health.configured ? (
                  <Badge color="#16a34a">Presente</Badge>
                ) : (
                  <Badge color="#dc2626">Ausente</Badge>
                )}
              </dd>
            </div>
            {!health.configured && health.missingVars.length > 0 && (
              <p className="text-xs text-slate-500">
                Falta definir: <span className="font-mono">{health.missingVars.join(", ")}</span>{" "}
                no <span className="font-mono">.env</span> da VPS (ou nos segredos do GitHub, se
                o deploy por SSH estiver ligado).
              </p>
            )}
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Portal</dt>
              <dd>
                {health.reachable === null ? (
                  <Badge>Não testado</Badge>
                ) : health.reachable ? (
                  <Badge color="#16a34a">Respondendo</Badge>
                ) : (
                  <Badge color="#dc2626">Sem resposta</Badge>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-slate-500">Última consulta bem-sucedida</dt>
              <dd className="text-slate-700">
                {health.lastSuccessAt
                  ? new Date(health.lastSuccessAt).toLocaleString("pt-BR")
                  : "nunca, desde que a API subiu"}
              </dd>
            </div>
          </dl>
        )
      )}
    </Card>
  );
}
