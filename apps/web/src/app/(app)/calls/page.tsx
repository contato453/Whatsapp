"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Download,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RefreshCw,
  Search,
  Trash2,
  Video,
} from "lucide-react";
import { api, callsApi, fetchAuthedBlobUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { downloadCallRecording } from "@/lib/media-download";
import type { CallLogDto, InstanceDto } from "@/lib/types";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  MultiSelect,
  Spinner,
  type MultiSelectGroup,
} from "@/components/ui";
import { AudioPlayer } from "@/components/inbox/audio-player";
import { cn } from "@/lib/utils";

/**
 * Registro de Ligações. Lista todas as chamadas (recebidas e feitas) no mesmo
 * recorte de acesso das conversas, com a gravação em MP3 que o AstraCalls
 * disponibiliza e filtros por período, situação, direção, tipo e conexão.
 *
 * Segue a identidade visual da casa: kit de UI (Card, Button, MultiSelect,
 * EmptyState), pílulas de período em `brand-600` e o mesmo player de áudio das
 * conversas.
 */

const PRESETS = [
  { key: "all", label: "Todas" },
  { key: "today", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
] as const;
type PresetKey = (typeof PRESETS)[number]["key"];

const PAGE_SIZE = 50;

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rangeFor(preset: PresetKey): { from: string | null; to: string | null } {
  if (preset === "all") return { from: null, to: null };
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  if (preset === "7d") from.setDate(from.getDate() - 6);
  if (preset === "30d") from.setDate(from.getDate() - 29);
  return { from: toDateInput(from), to: toDateInput(new Date()) };
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  accepted: { label: "Atendida", className: "text-emerald-600" },
  ended: { label: "Atendida", className: "text-emerald-600" },
  missed: { label: "Perdida", className: "text-rose-600" },
  rejected: { label: "Recusada", className: "text-rose-600" },
  ringing: { label: "Tocando", className: "text-slate-500" },
};

const STATUS_GROUP: MultiSelectGroup[] = [
  {
    label: null,
    options: [
      { value: "accepted", label: "Atendida" },
      { value: "missed", label: "Perdida" },
      { value: "rejected", label: "Recusada" },
    ],
  },
];

const DIRECTION_GROUP: MultiSelectGroup[] = [
  {
    label: null,
    options: [
      { value: "inbound", label: "Recebida" },
      { value: "outbound", label: "Realizada" },
    ],
  },
];

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CallsPage() {
  const { can } = useAuth();
  const canPlayRecording = can("call.recording.play");
  const canDeleteRecording = can("call.recording.delete");
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [preset, setPreset] = useState<PresetKey | "custom">("all");
  const initialFrom = new Date();
  initialFrom.setDate(initialFrom.getDate() - 6);
  const [customFrom, setCustomFrom] = useState(toDateInput(initialFrom));
  const [customTo, setCustomTo] = useState(toDateInput(new Date()));
  const [status, setStatus] = useState<string[]>([]);
  const [direction, setDirection] = useState<string[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [instances, setInstances] = useState<InstanceDto[]>([]);

  const [calls, setCalls] = useState<CallLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A lista já vem recortada pelo acesso de quem pediu; agent sem permissão
    // de conexões simplesmente não recebe nada aqui, e o filtro some.
    api
      .get<{ instances: InstanceDto[] }>("/whatsapp-instances")
      .then((data) => setInstances(data.instances))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const range = useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return rangeFor(preset);
  }, [preset, customFrom, customTo]);

  const filters = useMemo(
    () => ({
      from: range.from ?? undefined,
      to: range.to ?? undefined,
      status,
      direction,
      instanceId: instanceIds,
      search: debouncedSearch || undefined,
    }),
    [range, status, direction, instanceIds, debouncedSearch],
  );

  // Página fixa de 50: cada página SUBSTITUI a lista (não acumula), com
  // navegação Anterior/Próxima. `offset = página × 50`.
  const load = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const data = await callsApi.list({
          ...filters,
          limit: PAGE_SIZE,
          offset: nextPage * PAGE_SIZE,
        });
        setTotal(data.total);
        setPage(nextPage);
        setCalls(data.calls);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erro ao carregar as ligações");
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  // Trocar qualquer filtro recomeça da primeira página.
  useEffect(() => {
    void load(0);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasFilter =
    status.length > 0 ||
    direction.length > 0 ||
    instanceIds.length > 0 ||
    debouncedSearch.length > 0 ||
    preset !== "all";

  const instanceGroups: MultiSelectGroup[] = [
    { label: null, options: instances.map((i) => ({ value: i.id, label: i.name })) },
  ].filter((group) => group.options.length > 0);

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Ligações</h1>
        <div className="flex gap-2">
          {/* Manutenção de espaço: exclusão de gravações por período. Chave
              própria (padrão: só admin) — é destrutivo e libera disco da VPS. */}
          {canDeleteRecording && (
            <Button
              variant="outline"
              size="sm"
              className="border-rose-200 text-rose-700 hover:bg-rose-50"
              onClick={() => setPurgeOpen(true)}
            >
              <Trash2 className="h-4 w-4" /> Excluir gravações
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void load(0)} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </Button>
        </div>
      </div>
      {purgeOpen && (
        <PurgeRecordingsModal
          onClose={() => setPurgeOpen(false)}
          onDone={() => void load(0)}
        />
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PRESETS.map((option) => (
          <button
            key={option.key}
            onClick={() => setPreset(option.key)}
            className={
              preset === option.key
                ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            }
          >
            {option.label}
          </button>
        ))}
        <button
          onClick={() => setPreset("custom")}
          className={
            preset === "custom"
              ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
              : "rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
          }
        >
          Personalizado
        </button>

        <MultiSelect
          label="Situação"
          className="w-36"
          groups={STATUS_GROUP}
          selected={status}
          onChange={setStatus}
          searchPlaceholder="Buscar"
          emptyLabel="Nenhuma"
        />
        <MultiSelect
          label="Direção"
          className="w-36"
          groups={DIRECTION_GROUP}
          selected={direction}
          onChange={setDirection}
          searchPlaceholder="Buscar"
          emptyLabel="Nenhuma"
        />
        {instanceGroups.length > 0 && (
          <MultiSelect
            label="Conexão"
            className="w-40"
            groups={instanceGroups}
            selected={instanceIds}
            onChange={setInstanceIds}
            searchPlaceholder="Buscar conexão"
            emptyLabel="Nenhuma conexão"
          />
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nome ou telefone"
            className="w-48 pl-8"
          />
        </div>
        {preset === "custom" && (
          <span className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1"
            />
            até
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(event) => setCustomTo(event.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1"
            />
          </span>
        )}
      </div>

      {loading && calls.length === 0 ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : calls.length === 0 ? (
        <EmptyState
          title={hasFilter ? "Nada neste recorte" : "Nenhuma ligação ainda"}
          description={
            hasFilter
              ? "Ajuste os filtros para ver outras ligações."
              : "As chamadas recebidas e feitas aparecem aqui, com a gravação quando disponível."
          }
        />
      ) : (
        <>
          <p className="mb-2 text-xs text-slate-500">
            {total} {total === 1 ? "ligação" : "ligações"}
          </p>
          <Card className="divide-y divide-slate-100 p-0">
            {calls.map((call) => (
              <CallRow key={call.id} call={call} canPlayRecording={canPlayRecording} />
            ))}
          </Card>
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                Página {page + 1} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || page === 0}
                  onClick={() => void load(page - 1)}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading || page + 1 >= totalPages}
                  onClick={() => void load(page + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CallRow({ call, canPlayRecording }: { call: CallLogDto; canPlayRecording: boolean }) {
  const meta = STATUS_META[call.status] ?? STATUS_META.missed;
  const missed = call.status === "missed" || call.status === "rejected";
  const Icon = missed ? PhoneMissed : call.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
  const duration = formatDuration(call.durationSeconds);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100", meta.className)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-slate-900">
            {call.contactName ?? "Contato não identificado"}
          </span>
          {call.isVideo && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
              <Video className="h-3 w-3" /> Vídeo
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
          <span className={cn("font-medium", meta.className)}>{meta.label}</span>
          <span>·</span>
          <span>{call.direction === "outbound" ? "Realizada" : "Recebida"}</span>
          {duration && (
            <>
              <span>·</span>
              <span className="tabular-nums">{duration}</span>
            </>
          )}
          {call.instanceName && (
            <>
              <span>·</span>
              <span>{call.instanceName}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {call.hasRecording && canPlayRecording && (
          <div className="flex items-center gap-1.5 rounded-full bg-slate-50 px-3 py-1.5 ring-1 ring-slate-200">
            <AudioPlayer
              outbound={false}
              durationSeconds={call.durationSeconds ?? undefined}
              load={() => fetchAuthedBlobUrl(callsApi.recordingPath(call.id))}
            />
            <DownloadRecordingButton call={call} />
          </div>
        )}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-slate-400">
          {formatWhen(call.timestamp)}
        </span>
      </div>
    </div>
  );
}

/**
 * Botão de baixar a gravação, ao lado do player. Mesmo padrão de estado do
 * download de documento na bolha do chat (`message-bubble.tsx`): spinner
 * enquanto baixa, ícone volta ao normal depois — falha some sozinha no
 * próximo clique, sem texto extra que não cabe nesta linha estreita.
 */
function DownloadRecordingButton({ call }: { call: CallLogDto }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  async function download() {
    setDownloadFailed(false);
    setDownloading(true);
    try {
      // Mesmo caminho autenticado do player — um `<a href>` direto não envia
      // o header Authorization que a rota exige.
      await downloadCallRecording(call);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void download()}
      disabled={downloading}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60",
        downloadFailed ? "bg-rose-100 text-rose-600 hover:bg-rose-200" : "bg-slate-100 hover:bg-slate-200",
      )}
      aria-label={downloadFailed ? "Falha ao baixar — tentar de novo" : "Baixar gravação"}
      title={downloadFailed ? "Falha ao baixar — tentar de novo" : "Baixar gravação"}
    >
      {downloading ? <Spinner className="h-4 w-4" /> : <Download className="h-4 w-4" />}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Exclusão de gravações por período — ferramenta de espaço da VPS (admin). Só
 * o ÁUDIO é apagado; o registro da ligação continua na lista. Pede a data e
 * confirma antes de apagar, porque é irreversível.
 */
function PurgeRecordingsModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const [from, setFrom] = useState(toDateInput(new Date(2020, 0, 1)));
  const [to, setTo] = useState(toDateInput(monthAgo));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    recordsCleared: number;
    filesDeleted: number;
    freedBytes: number;
    fileErrors: number;
    diskConfigured: boolean;
  } | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const data = await callsApi.purgeRecordings(from, to);
      setResult(data);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao excluir as gravações.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Excluir gravações por período">
      {result ? (
        <div className="space-y-3 text-sm text-slate-600">
          <p className="font-medium text-slate-900">Pronto.</p>
          <ul className="space-y-1">
            <li>{result.filesDeleted} gravação(ões) apagada(s) do disco</li>
            <li>{formatBytes(result.freedBytes)} liberados</li>
            <li>{result.recordsCleared} ligação(ões) sem áudio agora</li>
            {result.fileErrors > 0 && (
              <li className="text-amber-600">
                {result.fileErrors} arquivo(s) não puderam ser apagados.
              </li>
            )}
            {!result.diskConfigured && (
              <li className="text-amber-600">
                O diretório das gravações não está configurado no servidor: os
                ponteiros foram limpos, mas os arquivos MP3 não foram apagados do
                disco. Configure <code>CALL_RECORDINGS_DIR</code> para liberar
                espaço de fato.
              </li>
            )}
          </ul>
          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Fechar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm text-slate-600">
          <p>
            Apaga as <strong>gravações em áudio</strong> das ligações no período
            escolhido para liberar espaço na VPS. O registro das ligações
            continua na lista — só o áudio é removido. <strong>Não dá para
            desfazer.</strong>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              De
              <input
                type="date"
                value={from}
                max={to}
                onChange={(event) => setFrom(event.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2">
              até
              <input
                type="date"
                value={to}
                min={from}
                onChange={(event) => setTo(event.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1"
              />
            </label>
          </div>
          <p className="text-xs text-slate-400">
            Dica: para liberar espaço mantendo o recente, apague tudo até ~30
            dias atrás (já preenchido).
          </p>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={running}>
              Cancelar
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => void run()}
              disabled={running}
            >
              {running ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
              Excluir gravações
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
