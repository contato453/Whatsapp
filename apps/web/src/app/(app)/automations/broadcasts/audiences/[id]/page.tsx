"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, FileSpreadsheet, Plus, Trash2, Upload } from "lucide-react";
import {
  guessImportRole,
  normalizeColumnKey,
  type BroadcastAudienceDto,
  type BroadcastContactDto,
  type BroadcastImportPreviewDto,
  type BroadcastImportResultDto,
} from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Spinner } from "@/components/ui";
import { BroadcastTabs, ImportTemplateButton } from "@/components/broadcasts/broadcast-ui";

/**
 * OS CONTATOS DE UMA AUDIÊNCIA — cadastro manual e importação de planilha.
 *
 * A importação é de DOIS PASSOS, e isso é o ponto da tela: o arquivo sobe
 * uma vez para a PRÉVIA (que só lê e devolve as colunas), a pessoa confere e
 * confirma qual coluna é telefone, nome e empresa, e só então o arquivo sobe
 * de novo para importar de verdade. Adivinhar a coluna sozinho importaria
 * 800 contatos com o telefone errado — e isso só se descobre quando o
 * disparo sai, quando não dá mais para desfazer.
 */
export default function BroadcastAudienceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can } = useAuth();
  const podeMontar = can("broadcast.audience.manage");

  const [audience, setAudience] = useState<BroadcastAudienceDto | null>(null);
  const [contacts, setContacts] = useState<BroadcastContactDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ phone: "", name: "", company: "" });
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BroadcastImportPreviewDto | null>(null);
  const [mapping, setMapping] = useState({ phone: "", name: "", company: "" });
  // Colunas que a pessoa DESLIGOU como variável. As variáveis em si são
  // derivadas do mapeamento (toda coluna que não é telefone, nome nem
  // empresa): guardar a lista pronta deixaria a coluna trocada no seletor
  // de telefone aparecendo ao mesmo tempo como variável.
  const [skippedExtras, setSkippedExtras] = useState<string[]>([]);
  const extras = preview
    ? preview.columns.filter(
        (coluna) =>
          coluna !== mapping.phone &&
          coluna !== mapping.name &&
          coluna !== mapping.company &&
          !skippedExtras.includes(coluna),
      )
    : [];
  const candidatasAVariavel = preview
    ? preview.columns.filter(
        (coluna) => coluna !== mapping.phone && coluna !== mapping.name && coluna !== mapping.company,
      )
    : [];
  const [importResult, setImportResult] = useState<BroadcastImportResultDto | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await broadcastApi.audiences.get(id);
      setAudience(data.audience);
      setContacts(data.contacts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível carregar a audiência");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function escolherArquivo(selecionado: File) {
    setFile(selecionado);
    setPreview(null);
    setImportResult(null);
    setError(null);
    setBusy(true);
    try {
      const resultado = await broadcastApi.audiences.previewImport(selecionado);
      setPreview(resultado);
      // Abre já com o palpite: a maioria das planilhas tem "Nome"/"Telefone",
      // e a pessoa só confirma. O palpite nunca importa sozinho.
      const telefone = resultado.columns.find((coluna) => guessImportRole(coluna) === "phone") ?? "";
      const nome = resultado.columns.find((coluna) => guessImportRole(coluna) === "name") ?? "";
      const empresa = resultado.columns.find((coluna) => guessImportRole(coluna) === "company") ?? "";
      setMapping({ phone: telefone, name: nome, company: empresa });
      setSkippedExtras([]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não consegui ler a planilha");
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function importar() {
    if (!file || !mapping.phone) return;
    setBusy(true);
    setError(null);
    try {
      const resultado = await broadcastApi.audiences.import(id, file, {
        phoneColumn: mapping.phone,
        nameColumn: mapping.name || undefined,
        companyColumn: mapping.company || undefined,
        extraColumns: extras,
      });
      setImportResult(resultado);
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível importar");
    } finally {
      setBusy(false);
    }
  }

  async function adicionarManual() {
    setBusy(true);
    setError(null);
    try {
      const resultado = await broadcastApi.audiences.addContacts(id, [
        {
          phone: manual.phone,
          name: manual.name.trim() || null,
          company: manual.company.trim() || null,
        },
      ]);
      if (resultado.invalid > 0) {
        setError(resultado.rejected[0]?.reason ?? "Telefone inválido");
      } else {
        setManualOpen(false);
        setManual({ phone: "", name: "", company: "" });
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível cadastrar");
    } finally {
      setBusy(false);
    }
  }

  async function removerContato(contato: BroadcastContactDto) {
    if (!window.confirm(`Tirar ${contato.phoneLabel} desta audiência?`)) return;
    try {
      await broadcastApi.audiences.removeContact(contato.id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível remover");
    }
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <Link
        href="/automations/broadcasts/audiences"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" /> Audiências
      </Link>

      <h1 className="text-2xl font-bold text-slate-900">{audience?.name ?? "Audiência"}</h1>
      <p className="mb-4 mt-0.5 text-sm text-slate-500">
        {audience?.description || "Contatos que as campanhas desta lista vão receber."}
      </p>
      <BroadcastTabs />

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {podeMontar && (
        <Card className="mb-5 p-5">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
            <FileSpreadsheet className="h-4 w-4 text-slate-400" /> Importar planilha
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            Aceita .xlsx, .xls e .csv. A primeira linha tem que ser o cabeçalho. Colunas além de
            nome, telefone e empresa viram variáveis{" "}
            <code className="rounded bg-slate-100 px-1">{"{{campo.coluna}}"}</code> para usar no
            texto da campanha. Não tem a planilha pronta? Baixe o modelo, preencha e importe aqui.
          </p>

          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(event) => {
              const selecionado = event.target.files?.[0];
              if (selecionado) void escolherArquivo(selecionado);
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Escolher planilha
            </Button>
            <ImportTemplateButton onError={setError} />
          </div>

          {preview && (
            <div className="mt-4 space-y-4 rounded-lg border border-slate-200 p-4">
              <p className="text-xs text-slate-500">
                Li <strong>{preview.totalRows}</strong> linha(s) de{" "}
                <strong>{file?.name}</strong>. Confira o que é cada coluna antes de importar.
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Telefone (obrigatório)">
                  <select
                    value={mapping.phone}
                    onChange={(event) => setMapping({ ...mapping, phone: event.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Escolha a coluna</option>
                    {preview.columns.map((coluna) => (
                      <option key={coluna} value={coluna}>
                        {coluna}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Nome">
                  <select
                    value={mapping.name}
                    onChange={(event) => setMapping({ ...mapping, name: event.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Nenhuma</option>
                    {preview.columns.map((coluna) => (
                      <option key={coluna} value={coluna}>
                        {coluna}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Empresa">
                  <select
                    value={mapping.company}
                    onChange={(event) => setMapping({ ...mapping, company: event.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Nenhuma</option>
                    {preview.columns.map((coluna) => (
                      <option key={coluna} value={coluna}>
                        {coluna}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {candidatasAVariavel.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-slate-700">
                    Variáveis para o texto da campanha
                  </p>
                  <p className="mb-2 text-xs text-slate-500">
                    Cada coluna marcada é guardada no contato e pode ser usada na mensagem. Desmarque
                    a que não interessa.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {candidatasAVariavel.map((coluna) => {
                      const ligada = !skippedExtras.includes(coluna);
                      const chave = normalizeColumnKey(coluna);
                      return (
                        <label
                          key={coluna}
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600"
                        >
                          <input
                            type="checkbox"
                            checked={ligada}
                            onChange={() =>
                              setSkippedExtras((atual) =>
                                ligada ? [...atual, coluna] : atual.filter((item) => item !== coluna),
                              )
                            }
                          />
                          {coluna}
                          {chave ? (
                            <code className="rounded bg-slate-100 px-1 text-[11px] text-slate-700">
                              {`{{campo.${chave}}}`}
                            </code>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {preview.sample.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        {preview.columns.map((coluna) => (
                          <th key={coluna} className="whitespace-nowrap px-2 py-1.5 font-medium">
                            {coluna}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((linha, indice) => (
                        <tr key={indice} className="border-b border-slate-100 text-slate-600">
                          {preview.columns.map((coluna) => (
                            <td key={coluna} className="whitespace-nowrap px-2 py-1.5">
                              {linha[coluna] || "—"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Button disabled={busy || !mapping.phone} onClick={() => void importar()}>
                Importar {preview.totalRows} contato(s)
              </Button>
            </div>
          )}

          {importResult && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <p className="font-medium text-slate-800">
                {importResult.imported} contato(s) importado(s).
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {importResult.duplicated} já estavam na lista · {importResult.invalid} com telefone
                inválido · {importResult.optedOut} estão descadastrados e não vão receber.
              </p>
              {importResult.rejected.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
                  {importResult.rejected.map((item) => (
                    <li key={`${item.row}-${item.phone}`}>
                      Linha {item.row}: {item.reason} ({item.phone || "vazio"})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">
          Contatos {audience ? `(${audience.contactCount})` : ""}
        </h2>
        {podeMontar && (
          <Button size="sm" variant="secondary" onClick={() => setManualOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Cadastrar na mão
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-8 w-8" />
        </div>
      ) : contacts.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            title="Nenhum contato ainda"
            description="Importe uma planilha ou cadastre na mão para começar."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-slate-100">
          {contacts.map((contato) => (
            <div key={contato.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">
                  {contato.name || contato.phoneLabel}
                </p>
                <p className="truncate text-xs text-slate-400">
                  {contato.phoneLabel}
                  {contato.company ? ` · ${contato.company}` : ""}
                  {Object.keys(contato.fields).length > 0
                    ? ` · ${Object.entries(contato.fields)
                        .map(([chave, valor]) => `${chave}: ${valor}`)
                        .join(" · ")}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {contato.optedOut && <Badge color="#d97706">Descadastrado</Badge>}
                {contato.source === "import" && <Badge>Planilha</Badge>}
                {podeMontar && (
                  <button
                    type="button"
                    title="Tirar da audiência"
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                    onClick={() => void removerContato(contato)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {audience && audience.contactCount > contacts.length && (
            <p className="p-3 text-xs text-slate-400">
              Mostrando os {contacts.length} mais recentes de {audience.contactCount}.
            </p>
          )}
        </Card>
      )}

      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title="Cadastrar contato">
        <div className="space-y-4">
          <Field label="Telefone">
            <Input
              value={manual.phone}
              onChange={(event) => setManual({ ...manual, phone: event.target.value })}
              placeholder="(11) 99999-8888"
              required
            />
          </Field>
          <Field label="Nome">
            <Input
              value={manual.name}
              onChange={(event) => setManual({ ...manual, name: event.target.value })}
              placeholder="Maria Souza"
            />
          </Field>
          <Field label="Empresa">
            <Input
              value={manual.company}
              onChange={(event) => setManual({ ...manual, company: event.target.value })}
              placeholder="Souza Comércio Ltda"
            />
          </Field>
          <Button
            className="w-full"
            disabled={busy || manual.phone.trim().length < 8}
            onClick={() => void adicionarManual()}
          >
            Cadastrar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
