"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CRM_ORIGINS,
  CRM_ORIGIN_LABELS,
  crmFinalValue,
  crmWeightedValue,
  formatCurrencyBRL,
} from "@azvchat/shared";
import { crmApi, type CrmOpportunityInput } from "@/lib/api";
import type {
  CrmOpportunityDto,
  CrmPipelineDto,
  CrmProductDto,
  TagDto,
  UserDirectoryDto,
} from "@/lib/types";
import { Button, Field, Input, Modal, Textarea } from "@/components/ui";

/**
 * Criar (ou editar) oportunidade.
 *
 * O QUE ESTE FORMULÁRIO NÃO PERGUNTA: nome e telefone do cliente, quando a
 * oportunidade nasce de uma conversa. Eles já existem no atendimento, e
 * pedi-los de novo é a definição de cadastro duplicado — a API herda tudo da
 * conversa (contato, departamento e responsável). Por isso o formulário aberto
 * do chat mostra o cliente como TEXTO, não como campo.
 *
 * O valor ponderado aparece enquanto a pessoa digita porque é ele que o
 * escritório soma no fim do mês: ver "R$ 6.000 ponderado" ao lado de
 * "R$ 10.000 a 60%" ensina o número sem precisar de treinamento.
 */
export function OpportunityForm({
  open,
  onClose,
  pipelines,
  products,
  users,
  tags,
  /** Conversa de origem — quando vem, o contato não é perguntado. */
  conversation,
  /** Preenchido = edição; ausente = criação. */
  editing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  pipelines: CrmPipelineDto[];
  products: CrmProductDto[];
  users: UserDirectoryDto[];
  tags: TagDto[];
  conversation?: { id: string; title: string } | null;
  editing?: CrmOpportunityDto | null;
  onSaved: (opportunity: CrmOpportunityDto, duplicated: boolean) => void;
}) {
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [productId, setProductId] = useState("");
  const [value, setValue] = useState("");
  const [discount, setDiscount] = useState("");
  const [probability, setProbability] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [origin, setOrigin] = useState("");
  const [notes, setNotes] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const funil = pipelines.find((item) => item.id === pipelineId) ?? null;

  useEffect(() => {
    if (!open) return;
    setErro(null);
    if (editing) {
      setPipelineId(editing.pipelineId);
      setStageId(editing.stageId);
      setTitle(editing.title);
      setContactName(editing.contactName ?? "");
      setContactPhone(editing.contactPhone ?? "");
      setAssignedUserId(editing.assignedUser?.id ?? "");
      setProductId(editing.product?.id ?? "");
      setValue(editing.value ? String(editing.value) : "");
      setDiscount(editing.discount ? String(editing.discount) : "");
      setProbability(editing.probability != null ? String(editing.probability) : "");
      setExpectedCloseDate(editing.expectedCloseDate?.slice(0, 10) ?? "");
      setOrigin(editing.origin ?? "");
      setNotes(editing.notes ?? "");
      setTagIds(editing.tags.map((tag) => tag.id));
      return;
    }
    const padrao = pipelines.find((item) => item.isDefault) ?? pipelines[0];
    setPipelineId(padrao?.id ?? "");
    setStageId(padrao?.stages[0]?.id ?? "");
    setTitle(conversation?.title ?? "");
    setContactName("");
    setContactPhone("");
    setAssignedUserId("");
    setProductId("");
    setValue("");
    setDiscount("");
    setProbability("");
    setExpectedCloseDate("");
    setOrigin(conversation ? "whatsapp" : "manual");
    setNotes("");
    setTagIds([]);
  }, [open, editing, conversation, pipelines]);

  // Trocar de funil zera a etapa: etapa de outro funil não é destino válido, e
  // a API recusaria — melhor a tela nunca oferecer.
  useEffect(() => {
    if (!funil) return;
    if (!funil.stages.some((stage) => stage.id === stageId)) {
      setStageId(funil.stages[0]?.id ?? "");
    }
  }, [funil, stageId]);

  const etapa = funil?.stages.find((item) => item.id === stageId) ?? null;
  const numero = (texto: string): number | null => {
    const limpo = texto.replace(/\./g, "").replace(",", ".").trim();
    if (!limpo) return null;
    const valor = Number(limpo);
    return Number.isFinite(valor) ? valor : null;
  };

  const previsao = useMemo(() => {
    const bruto = numero(value) ?? 0;
    const abatimento = numero(discount);
    const finalValue = crmFinalValue(bruto, abatimento);
    const chance = numero(probability) ?? etapa?.probability ?? 0;
    return { finalValue, weighted: crmWeightedValue(finalValue, chance), chance };
  }, [value, discount, probability, etapa]);

  async function salvar() {
    if (!pipelineId) {
      setErro("Escolha um funil.");
      return;
    }
    setSalvando(true);
    setErro(null);
    try {
      const base = {
        title: title.trim() || undefined,
        contactName: contactName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        assignedUserId: assignedUserId || null,
        productId: productId || null,
        value: numero(value) ?? 0,
        discount: numero(discount),
        probability: numero(probability) != null ? Math.round(numero(probability) as number) : null,
        expectedCloseDate: expectedCloseDate
          ? new Date(`${expectedCloseDate}T12:00:00`).toISOString()
          : null,
        origin: origin || null,
        notes: notes.trim() || null,
      };
      if (editing) {
        const atualizada = await crmApi.update(editing.id, base);
        onSaved(atualizada, false);
      } else {
        const input: CrmOpportunityInput = {
          ...base,
          pipelineId,
          stageId: stageId || null,
          conversationId: conversation?.id ?? null,
          tagIds,
        };
        const { opportunity, duplicated } = await crmApi.create(input);
        onSaved(opportunity, duplicated);
      }
      onClose();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Não foi possível salvar");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={editing ? "Editar oportunidade" : "Nova oportunidade"}
    >
      <div className="space-y-4">
        {conversation && !editing && (
          // Cliente como TEXTO, não como campo: quem já está conversando não
          // precisa ser cadastrado de novo.
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Cliente: <span className="font-medium text-slate-800">{conversation.title}</span> — o
            contato e o histórico vêm da conversa, sem cadastro novo.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Funil">
            <select
              value={pipelineId}
              disabled={Boolean(editing)}
              onChange={(event) => setPipelineId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
            >
              {pipelines.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Etapa">
            <select
              value={stageId}
              disabled={Boolean(editing)}
              onChange={(event) => setStageId(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
            >
              {(funil?.stages ?? []).map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name} ({stage.probability}%)
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Título da oportunidade">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={conversation?.title ?? "Ex.: Abertura de empresa — Cliente X"}
          />
        </Field>

        {!conversation && !editing && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome do contato (lead sem conversa)">
              <Input value={contactName} onChange={(event) => setContactName(event.target.value)} />
            </Field>
            <Field label="Telefone">
              <Input
                value={contactPhone}
                onChange={(event) => setContactPhone(event.target.value)}
                placeholder="5521999999999"
              />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Serviço">
            <select
              value={productId}
              onChange={(event) => {
                setProductId(event.target.value);
                const produto = products.find((item) => item.id === event.target.value);
                // Valor sugerido do catálogo só preenche campo VAZIO: escrever
                // por cima do que a pessoa digitou seria perder a negociação
                // real por causa de uma tabela.
                if (produto?.defaultValue && !value) setValue(String(produto.defaultValue));
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Sem serviço</option>
              {products
                .filter((item) => item.active || item.id === productId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Valor estimado (R$)">
            <Input value={value} onChange={(event) => setValue(event.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Desconto (R$)">
            <Input
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              inputMode="decimal"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={`Probabilidade (%) — etapa: ${etapa?.probability ?? 0}%`}>
            <Input
              value={probability}
              onChange={(event) => setProbability(event.target.value)}
              inputMode="numeric"
              placeholder={String(etapa?.probability ?? 0)}
            />
          </Field>
          <Field label="Previsão de fechamento">
            <Input
              type="date"
              value={expectedCloseDate}
              onChange={(event) => setExpectedCloseDate(event.target.value)}
            />
          </Field>
          <Field label="Origem">
            <select
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Sem origem</option>
              {CRM_ORIGINS.map((item) => (
                <option key={item} value={item}>
                  {CRM_ORIGIN_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Responsável">
          <select
            value={assignedUserId}
            onChange={(event) => setAssignedUserId(event.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">
              {conversation ? "Herdar da conversa" : "Sem responsável"}
            </option>
            {users
              .filter((user) => user.status === "active")
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
          </select>
        </Field>

        {!editing && tags.length > 0 && (
          <Field label="Etiquetas">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => {
                const marcada = tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setTagIds((atual) =>
                        marcada ? atual.filter((id) => id !== tag.id) : [...atual, tag.id],
                      )
                    }
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      backgroundColor: marcada ? tag.color : `${tag.color}1a`,
                      color: marcada ? "#fff" : tag.color,
                    }}
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        <Field label="Observações">
          <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </Field>

        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Valor final <strong>{formatCurrencyBRL(previsao.finalValue)}</strong> · ponderado a{" "}
          {previsao.chance}%: <strong>{formatCurrencyBRL(previsao.weighted)}</strong>
        </p>

        {erro && <p className="text-xs text-red-600">{erro}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={() => void salvar()} disabled={salvando}>
            {salvando ? "Salvando..." : editing ? "Salvar" : "Criar oportunidade"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
