"use client";

import { useCallback, useEffect, useState } from "react";
import { QUALITY_SUBJECTS } from "@azvchat/shared";
import { qualityApi } from "@/lib/api";
import type { QualityEvaluationDto, QualitySubject, UserDirectoryDto } from "@/lib/types";
import { Card, EmptyState, Input, Spinner } from "@/components/ui";
import { EvaluationDetail } from "./evaluation-detail";
import { QUALITY_SUBJECT_LABELS, dateInputValue } from "./quality-ui";

/**
 * A LISTA DE AVALIAÇÕES, com os filtros da tela: atendente, período, assunto e
 * nota. Os filtros vão para a API, que é quem recorta — filtrar no navegador
 * daria uma lista curta sem explicação quando o teto de linhas fosse atingido.
 */
export function EvaluationList({ users }: { users: UserDirectoryDto[] }) {
  const [userId, setUserId] = useState("");
  const [subject, setSubject] = useState<QualitySubject | "">("");
  const [de, setDe] = useState(() => dateInputValue(new Date(Date.now() - 29 * 86_400_000)));
  const [ate, setAte] = useState(() => dateInputValue(new Date()));
  const [notaMinima, setNotaMinima] = useState("");
  const [notaMaxima, setNotaMaxima] = useState("");
  const [incluirDescartadas, setIncluirDescartadas] = useState(false);
  const [evaluations, setEvaluations] = useState<QualityEvaluationDto[] | null>(null);

  const carregar = useCallback(() => {
    setEvaluations(null);
    qualityApi
      .evaluations({
        userId: userId || undefined,
        subject: subject || undefined,
        from: new Date(`${de}T00:00:00`).toISOString(),
        to: new Date(`${ate}T23:59:59`).toISOString(),
        minScore: notaMinima === "" ? undefined : Number(notaMinima),
        maxScore: notaMaxima === "" ? undefined : Number(notaMaxima),
        includeDiscarded: incluirDescartadas || undefined,
      })
      .then(setEvaluations)
      .catch(() => setEvaluations([]));
  }, [userId, subject, de, ate, notaMinima, notaMaxima, incluirDescartadas]);

  useEffect(carregar, [carregar]);

  function trocar(evaluation: QualityEvaluationDto): void {
    setEvaluations((atual) =>
      atual ? atual.map((current) => (current.id === evaluation.id ? evaluation : current)) : atual,
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Atendente</span>
            <select
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Assunto</span>
            <select
              value={subject}
              onChange={(event) => setSubject(event.target.value as QualitySubject | "")}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Todos</option>
              {QUALITY_SUBJECTS.map((value) => (
                <option key={value} value={value}>
                  {QUALITY_SUBJECT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Período avaliado de</span>
            <Input type="date" value={de} max={ate} onChange={(event) => setDe(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Até</span>
            <Input type="date" value={ate} min={de} onChange={(event) => setAte(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Nota mínima</span>
            <Input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={notaMinima}
              onChange={(event) => setNotaMinima(event.target.value)}
              placeholder="0"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Nota máxima</span>
            <Input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={notaMaxima}
              onChange={(event) => setNotaMaxima(event.target.value)}
              placeholder="10"
            />
          </label>
          <label className="flex items-center gap-2 pt-5 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={incluirDescartadas}
              onChange={(event) => setIncluirDescartadas(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Mostrar também as descartadas
          </label>
        </div>
      </Card>

      {!evaluations ? <Spinner className="mx-auto mt-10 h-6 w-6" /> : null}
      {evaluations && evaluations.length === 0 ? (
        <EmptyState
          title="Nenhuma avaliação com este recorte"
          description="Ajuste os filtros ou dispare uma análise nova."
        />
      ) : null}
      {evaluations?.map((evaluation) => (
        <EvaluationDetail
          key={evaluation.id}
          evaluation={evaluation}
          runId={evaluation.runId}
          itemId={evaluation.itemId}
          onChanged={trocar}
        />
      ))}
    </div>
  );
}
