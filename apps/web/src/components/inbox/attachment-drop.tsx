"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, FileText, Image as ImageIcon, Music4, Send, Upload, Video, X } from "lucide-react";
import {
  ATTACHMENT_MAX_FILES,
  CONNECTION_STATUS_LABELS,
  DEFAULT_MEDIA_MAX_SIZE,
  attachmentRejection,
  attachmentRejectionMessage,
  formatFileSize,
  generatedAttachmentName,
  isGenericAttachmentName,
  outboundMediaTypeFromMime,
  tooManyAttachmentsMessage,
  type ConnectionStatus,
  type OutboundMediaType,
} from "@azvchat/shared";
import { conversationMediaApi } from "@/lib/api";
import type { MessageDto } from "@/lib/types";
import { Badge, Button, Modal, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Arrastar arquivo para dentro da conversa e colar com Ctrl+V.
 *
 * Vive em componente próprio (e não no `inbox-shell`, que já passa de mil
 * linhas) porque é um gesto fechado: arrasto, colagem, prévia e envio contam
 * a mesma história, e o shell só precisa dizer qual conversa está aberta.
 *
 * **Nada é enviado sem prévia.** No WhatsApp mensagem enviada não se desfaz:
 * um Ctrl+V errado, ou o arquivo solto na conversa que estava aberta um
 * segundo antes, mandaria o comprovante de um cliente para outro sem chance
 * de cancelar. Por isso os dois gestos param numa prévia com enviar e
 * cancelar — o custo é um clique, e ele paga sozinho no primeiro susto.
 *
 * O envio reusa o caminho que já existia (`conversationMediaApi`, a rota
 * `POST /conversations/:id/messages/media`): um arquivo por requisição, uma
 * mensagem por arquivo. Nada de rota nova, nada de auditoria nova — para a
 * API isto é o mesmo envio do clipe do composer.
 */

/** Item aguardando confirmação na prévia. */
interface PendingAttachment {
  id: string;
  file: File;
  kind: OutboundMediaType;
  /** URL temporária da miniatura (imagem e vídeo) — revogada ao sair da prévia. */
  previewUrl: string | null;
  status: "pending" | "sending" | "sent" | "failed";
  error: string | null;
}

/** Candidato bruto do arrasto ou da colagem, antes da validação. */
interface IncomingFile {
  file: File | null;
  isFolder: boolean;
  name: string;
}

const KIND_ICON: Record<OutboundMediaType, ReactNode> = {
  image: <ImageIcon className="h-5 w-5" />,
  video: <Video className="h-5 w-5" />,
  audio: <Music4 className="h-5 w-5" />,
  document: <FileText className="h-5 w-5" />,
};

/**
 * O arrasto carrega arquivo? É a única leitura confiável durante o
 * `dragover` — os itens só liberam o conteúdo no `drop`. Texto selecionado da
 * própria página e link arrastado ficam de fora: abrir a sobreposição neles
 * prometeria um envio que não vai acontecer.
 */
function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types).includes("Files");
}

/** Extrai os arquivos do arrasto, marcando quais itens eram pasta. */
function filesFromDrop(transfer: DataTransfer): IncomingFile[] {
  const items = Array.from(transfer.items).filter((item) => item.kind === "file");
  if (items.length > 0) {
    // `webkitGetAsEntry` só pode ser chamado ainda dentro do handler do drop:
    // depois de qualquer await o navegador já esvaziou o DataTransfer.
    return items.map((item) => {
      const entry = item.webkitGetAsEntry();
      const file = item.getAsFile();
      return {
        file,
        // Pasta é recusada sem tentar percorrer o diretório: o atendente acha
        // que mandou uma pasta e o cliente receberia trinta mensagens.
        isFolder: entry ? !entry.isFile : false,
        name: entry?.name ?? file?.name ?? "",
      };
    });
  }
  return Array.from(transfer.files).map((file) => ({ file, isFolder: false, name: file.name }));
}

/**
 * Marca os únicos campos de texto em que a colagem de arquivo é NOSSA: o
 * composer da conversa e a legenda da prévia. Precisa ser uma marcação
 * explícita, e não "está dentro da área da conversa": a busca dentro da
 * conversa mora ali dentro também, e lá o Ctrl+V é do campo de busca.
 */
export const ATTACHMENT_PASTE_FIELD = "composer";

/**
 * O foco está num campo de texto que NÃO é o composer (busca da conversa,
 * nome de participante, legenda de agendamento)? Ali o Ctrl+V é do campo, e
 * interceptar tiraria da pessoa a colagem mais banal do sistema.
 */
function isForeignTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable;
  if (!editable) return false;
  return target.dataset.attachmentPaste !== ATTACHMENT_PASTE_FIELD;
}

/**
 * Impede o navegador de abrir o arquivo solto FORA da área válida.
 *
 * Sem isto, soltar um PDF na lista de conversas, no painel de contexto ou no
 * menu troca a página pelo arquivo e o atendente perde a tela inteira. Só
 * bloqueia arrasto que carrega arquivo — arrastar texto para dentro de um
 * campo continua funcionando.
 *
 * Fica separado da zona de propósito: precisa valer também quando nenhuma
 * conversa está aberta, quando a zona não existe na tela.
 */
export function useBlockStrayFileDrop(): void {
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);
}

export interface AttachmentDropZoneProps {
  /** Conversa aberta. Sem ela o arrasto não faz nada e a sobreposição não aparece. */
  conversationId: string | null;
  conversationTitle: string | null;
  /** Conexão do número: desconectado, a prévia avisa antes de a pessoa tentar. */
  instanceStatus: ConnectionStatus | null;
  /**
   * Texto ainda não enviado do composer — entra como legenda inicial. Vem
   * vazio no modo nota interna: nota não vira legenda de mídia do cliente.
   */
  captionSeed: string;
  /**
   * Chamado depois do envio bem-sucedido, com a conversa de destino: é aí que
   * o composer é limpo, e não antes. Falhou, o texto continua onde estava.
   */
  onCaptionConsumed: (conversationId: string) => void;
  onMessageSent: (message: MessageDto) => void;
  /**
   * Desliga os dois gestos: gravação de áudio em andamento, envio em curso ou
   * outro modal aberto (encaminhar, agendar, mídia ampliada). Sem isso o
   * Ctrl+V dado dentro de um modal abriria a prévia por cima dele.
   */
  disabled?: boolean;
  children: ReactNode;
}

export function AttachmentDropZone({
  conversationId,
  conversationTitle,
  instanceStatus,
  captionSeed,
  onCaptionConsumed,
  onMessageSent,
  disabled,
  children,
}: AttachmentDropZoneProps): ReactNode {
  const zoneRef = useRef<HTMLDivElement | null>(null);
  /**
   * Profundidade do arrasto. `dragenter`/`dragleave` disparam também nos
   * elementos filhos: com um booleano a sobreposição piscaria a cada bolha de
   * mensagem que o cursor cruzasse. O contador só zera quando o arrasto
   * saiu da área de verdade.
   */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [rejections, setRejections] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  /** A legenda veio do composer? Só então o composer é limpo no fim. */
  const [captionFromComposer, setCaptionFromComposer] = useState(false);
  const [sending, setSending] = useState(false);
  /** Trava do clique duplo: o estado do React não chega a tempo do segundo clique. */
  const sendingRef = useRef(false);
  /** A legenda já saiu (com a mídia ou como texto)? Retentativa não repete. */
  const captionSentRef = useRef(false);

  /**
   * Conversa a que a prévia pertence, congelada na abertura. Trocar de
   * conversa com a prévia aberta NÃO redireciona os arquivos: eles continuam
   * indo para onde foram soltos, e a prévia avisa em cima. Mandar comprovante
   * para o cliente errado é erro que nenhum "desconsidere" conserta.
   */
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);

  const open = items.length > 0 || rejections.length > 0;
  const switchedAway = target !== null && conversationId !== null && conversationId !== target.id;

  function revoke(list: PendingAttachment[]): void {
    for (const item of list) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }

  /**
   * Miniatura é URL temporária: sem revogar, a memória cresce a cada prévia
   * aberta e o navegador do atendente vai ficando pesado ao longo do dia. O
   * ref existe porque a limpeza da desmontagem precisa da lista ATUAL, não da
   * lista vazia do primeiro render.
   */
  const itemsRef = useRef<PendingAttachment[]>([]);
  itemsRef.current = items;
  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  /**
   * O arrasto terminou em qualquer lugar da janela: zera o contador. Sem
   * isto, soltar o arquivo FORA da área válida (na lista, no painel) deixaria
   * a sobreposição acesa para sempre — o `dragleave` da zona não chega quando
   * o navegador cancela o arrasto por conta própria.
   */
  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  const closePreview = useCallback((list: PendingAttachment[]) => {
    revoke(list);
    setItems([]);
    setRejections([]);
    setCaption("");
    setCaptionFromComposer(false);
    setTarget(null);
    captionSentRef.current = false;
  }, []);

  /** Esc e Cancelar com arquivo na prévia pedem confirmação — descartar dói. */
  const requestClose = useCallback(() => {
    if (sending) return;
    const pending = itemsRef.current.filter((item) => item.status !== "sent");
    if (pending.length > 0) {
      const message =
        pending.length === 1
          ? "Descartar o arquivo sem enviar?"
          : `Descartar os ${pending.length} arquivos sem enviar?`;
      if (!window.confirm(message)) return;
    }
    closePreview(itemsRef.current);
  }, [closePreview, sending]);

  /**
   * Entrada única dos dois gestos: valida, gera miniatura e empilha na prévia.
   * Pode ser chamada com a prévia já aberta — arrastar ou colar de novo
   * acrescenta, em vez de substituir.
   */
  const addFiles = useCallback(
    (incoming: IncomingFile[], options: { renameGeneric?: boolean; suggestedCaption?: string } = {}) => {
      if (!conversationId) return;
      /**
       * Prévia aberta de OUTRA conversa: o arquivo novo não entra nela. Ele
       * iria para o destino congelado, e não para a conversa que a pessoa
       * está vendo — exatamente o erro que a prévia existe para evitar.
       */
      if (target && target.id !== conversationId) {
        setRejections((current) => [
          ...current,
          `A prévia aberta é da conversa “${target.title}”. Envie ou cancele antes de anexar nesta.`,
        ]);
        return;
      }
      const problems: string[] = [];
      const accepted: PendingAttachment[] = [];
      const now = new Date();
      const room = Math.max(0, ATTACHMENT_MAX_FILES - itemsRef.current.length);
      /** Arquivo válido que não entrou por causa do teto — nem todo recusado é isso. */
      let overflow = 0;

      for (const entry of incoming) {
        const size = entry.file?.size ?? 0;
        const reason = attachmentRejection(
          { size, isFolder: entry.isFolder || !entry.file },
          DEFAULT_MEDIA_MAX_SIZE,
        );
        if (reason || !entry.file) {
          // Barrado aqui, na prévia, antes de subir um byte: o limite aparece
          // em números na mensagem, senão a recusa não ensina nada.
          problems.push(
            attachmentRejectionMessage(entry.name, reason ?? "folder", {
              size,
              maxSize: DEFAULT_MEDIA_MAX_SIZE,
            }),
          );
          continue;
        }
        if (accepted.length >= room) {
          overflow += 1;
          continue;
        }
        const kind = outboundMediaTypeFromMime(entry.file.type);
        // Print de tela chega como "image.png" (quando chega com nome): o nome
        // gerado com data e hora é o que a equipe vai ver na Inbox depois.
        const file =
          options.renameGeneric && isGenericAttachmentName(entry.file.name)
            ? new File([entry.file], generatedAttachmentName(entry.file.type, now), {
                type: entry.file.type,
              })
            : entry.file;
        accepted.push({
          id: crypto.randomUUID(),
          file,
          kind,
          previewUrl: kind === "image" || kind === "video" ? URL.createObjectURL(file) : null,
          status: "pending",
          error: null,
        });
      }

      if (overflow > 0) problems.push(tooManyAttachmentsMessage(overflow));

      if (accepted.length > 0) setItems((current) => [...current, ...accepted]);
      if (problems.length > 0) setRejections((current) => [...current, ...problems]);

      // A prévia nasce amarrada à conversa em que o gesto aconteceu.
      setTarget(
        (current) => current ?? { id: conversationId, title: conversationTitle ?? "esta conversa" },
      );

      if (caption.length === 0) {
        // Texto colado junto da imagem (copiar de editor manda os dois) vira
        // legenda sugerida, nunca mensagem separada. O rascunho do composer
        // entra quando não veio texto no clipboard.
        const suggested = options.suggestedCaption?.trim() ?? "";
        if (suggested.length > 0) {
          setCaption(suggested);
          setCaptionFromComposer(false);
        } else if (captionSeed.trim().length > 0) {
          setCaption(captionSeed);
          setCaptionFromComposer(true);
        }
      }
    },
    [caption, captionSeed, conversationId, conversationTitle, target],
  );

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    const found = itemsRef.current.find((item) => item.id === id);
    if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
  }

  // ---------- Arrastar ----------
  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (conversationId && !disabled) setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event.dataTransfer)) return;
    // Sem o preventDefault no dragover o navegador nem chama o drop.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!conversationId || disabled) return;
    addFiles(filesFromDrop(event.dataTransfer));
  }

  // ---------- Colar ----------
  /**
   * Só intercepta quando o clipboard traz ARQUIVO. Colar texto é a operação
   * mais comum do composer (protocolo, CNPJ, trecho de e-mail) e continua
   * caindo no campo de digitação, sem passar por aqui — por isso a decisão
   * olha os itens do clipboard, um por um, e não a tecla apertada.
   */
  useEffect(() => {
    if (!conversationId || disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const fileItems = Array.from(data.items).filter((item) => item.kind === "file");
      if (fileItems.length === 0) return;
      if (isForeignTextField(event.target)) return;
      event.preventDefault();
      const text = data.getData("text/plain");
      addFiles(
        fileItems.map((item) => {
          const file = item.getAsFile();
          return { file, isFolder: false, name: file?.name ?? "" };
        }),
        { renameGeneric: true, suggestedCaption: text },
      );
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addFiles, conversationId, disabled]);

  // ---------- Envio ----------
  /**
   * Um arquivo, uma mensagem, na ordem em que aparecem na prévia — é assim
   * que o cliente vê no WhatsApp. Sequencial de propósito: em paralelo a
   * ordem no chat sairia embaralhada.
   *
   * A legenda acompanha a primeira mídia que aceita legenda. Áudio não aceita
   * (o WhatsApp não mostra texto em áudio), então numa prévia só de áudios o
   * texto sai como mensagem separada — a mesma regra da mídia de resposta
   * rápida. Falha em um arquivo não cancela os outros: ele fica marcado para
   * tentar de novo, e a legenda que já saiu não é reenviada.
   */
  const sendAll = useCallback(async () => {
    if (sendingRef.current || !target) return;
    const working = [...itemsRef.current];
    if (working.every((item) => item.status === "sent")) return;
    sendingRef.current = true;
    setSending(true);
    setRejections([]);
    const trimmedCaption = caption.trim();
    let sentAny = false;

    for (let index = 0; index < working.length; index += 1) {
      const item = working[index];
      if (!item || item.status === "sent") continue;
      working[index] = { ...item, status: "sending", error: null };
      setItems([...working]);
      const withCaption =
        !captionSentRef.current && trimmedCaption.length > 0 && item.kind !== "audio";
      try {
        const message = await conversationMediaApi.send(target.id, item.file, {
          ...(withCaption ? { caption: trimmedCaption } : {}),
        });
        if (withCaption) captionSentRef.current = true;
        sentAny = true;
        onMessageSent(message);
        working[index] = { ...item, status: "sent", error: null };
      } catch (err) {
        working[index] = {
          ...item,
          status: "failed",
          error: err instanceof Error ? err.message : "Falha ao enviar",
        };
      }
      setItems([...working]);
    }

    const failures: string[] = [];
    if (sentAny && trimmedCaption.length > 0 && !captionSentRef.current) {
      try {
        onMessageSent(await conversationMediaApi.sendText(target.id, trimmedCaption));
        captionSentRef.current = true;
      } catch {
        failures.push("A mídia foi enviada, mas o texto da legenda falhou — mande o texto de novo.");
      }
    }

    sendingRef.current = false;
    setSending(false);
    // O composer só é limpo agora, com o envio confirmado: limpar antes
    // perderia o texto se a conexão do número estivesse fora do ar.
    if (sentAny && captionFromComposer) onCaptionConsumed(target.id);

    const remaining = working.filter((item) => item.status !== "sent");
    revoke(working.filter((item) => item.status === "sent"));
    if (remaining.length === 0 && failures.length === 0) {
      closePreview([]);
      return;
    }
    setItems(remaining);
    if (failures.length > 0) setRejections(failures);
  }, [caption, captionFromComposer, closePreview, onCaptionConsumed, onMessageSent, target]);

  /**
   * Esc fecha (com confirmação), Enter envia — o `Modal` do kit não trata
   * teclado. Em fase de CAPTURA e cortando a propagação de propósito: com a
   * prévia aberta o foco pode ter ficado no composer atrás dela, e aí o mesmo
   * Enter enviaria também o texto do rascunho como mensagem solta.
   * Shift+Enter segue intacto para quebrar linha na legenda.
   */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void sendAll();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, requestClose, sendAll]);

  const totalSize = useMemo(() => items.reduce((sum, item) => sum + item.file.size, 0), [items]);
  const failed = items.filter((item) => item.status === "failed").length;
  const sentCount = items.filter((item) => item.status === "sent").length;
  const disconnected = instanceStatus !== null && instanceStatus !== "connected";

  return (
    <div
      ref={zoneRef}
      // `min-w-0` porque a zona virou o filho flexível da linha da Inbox:
      // sem ele, nome de arquivo longo empurraria a coluna do chat.
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}

      {/* Sobreposição do arrasto: diz o que vai acontecer antes de soltar. */}
      {dragging && conversationId && !disabled && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-brand-600/10 p-6">
          <div className="rounded-2xl border-2 border-dashed border-brand-500 bg-white/95 px-8 py-6 text-center shadow-lg">
            <Upload className="mx-auto mb-2 h-8 w-8 text-brand-600" />
            <p className="text-sm font-semibold text-slate-900">Solte para anexar</p>
            <p className="mt-1 text-xs text-slate-500">
              Abre uma prévia antes de enviar — nada vai para o cliente ainda.
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              Até {ATTACHMENT_MAX_FILES} arquivos, {formatFileSize(DEFAULT_MEDIA_MAX_SIZE)} cada
            </p>
          </div>
        </div>
      )}

      <Modal
        open={open}
        onClose={requestClose}
        wide
        title={items.length > 1 ? `Enviar ${items.length} arquivos` : "Enviar arquivo"}
      >
        <div className="space-y-3">
          {target && (
            <p className="text-xs text-slate-500">
              Para <span className="font-semibold text-slate-700">{target.title}</span>
              {items.length > 0 && ` · ${formatFileSize(totalSize)}`}
            </p>
          )}

          {/* Trocou de conversa com a prévia aberta: o destino continua sendo
              o de origem, e a tela diz isso antes de a pessoa clicar. */}
          {switchedAway && target && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Você trocou de conversa. Estes arquivos continuam indo para{" "}
                <span className="font-semibold">{target.title}</span> — cancele se não era isso.
              </span>
            </p>
          )}

          {disconnected && instanceStatus && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                O número está {CONNECTION_STATUS_LABELS[instanceStatus].toLowerCase()}: o envio vai
                falhar enquanto a conexão não voltar.
              </span>
            </p>
          )}

          {rejections.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              {rejections.map((message, index) => (
                <li key={`${index}-${message}`} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{message}</span>
                </li>
              ))}
            </ul>
          )}

          {items.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
              Nenhum arquivo na prévia. Arraste ou cole outro para tentar de novo.
            </p>
          ) : (
            <ul className="thin-scroll max-h-64 space-y-1.5 overflow-y-auto">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-2.5 py-2",
                    item.status === "failed"
                      ? "border-red-200 bg-red-50"
                      : item.status === "sent"
                        ? "border-emerald-200 bg-emerald-50"
                        : "border-slate-200 bg-white",
                  )}
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-slate-500">
                    {item.previewUrl && item.kind === "image" ? (
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="h-full w-full object-cover"
                      />
                    ) : item.previewUrl && item.kind === "video" ? (
                      <video
                        src={item.previewUrl}
                        muted
                        playsInline
                        preload="metadata"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      KIND_ICON[item.kind]
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-800">{item.file.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {formatFileSize(item.file.size)}
                      {item.error && <span className="text-red-600"> · {item.error}</span>}
                    </p>
                  </div>
                  {item.status === "sending" && <Spinner className="h-4 w-4 shrink-0" />}
                  {item.status === "sent" && (
                    <Badge className="shrink-0 bg-emerald-100 text-emerald-700">Enviado</Badge>
                  )}
                  {item.status === "failed" && (
                    <Badge className="shrink-0 bg-red-100 text-red-700">Falhou</Badge>
                  )}
                  {!sending && item.status !== "sent" && (
                    <button
                      onClick={() => removeItem(item.id)}
                      className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      aria-label={`Remover ${item.file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-1">
            <Textarea
              rows={2}
              value={caption}
              disabled={sending}
              onChange={(event) => setCaption(event.target.value)}
              placeholder="Legenda (opcional)"
              // Colar arquivo aqui acrescenta na prévia (ver isForeignTextField).
              data-attachment-paste={ATTACHMENT_PASTE_FIELD}
              className="resize-none"
            />
            <p className="text-[11px] text-slate-400">
              {items.length > 1
                ? "A legenda acompanha o primeiro arquivo. Enter envia, Esc cancela."
                : "Enter envia, Esc cancela. Shift+Enter quebra linha."}
            </p>
          </div>

          <div className="flex items-center justify-end gap-2">
            {sending ? (
              <span className="mr-auto text-xs text-slate-500">
                Enviando {Math.min(sentCount + 1, items.length)} de {items.length}...
              </span>
            ) : (
              failed > 0 && (
                <span className="mr-auto text-xs text-red-600">
                  {failed === 1 ? "1 arquivo falhou" : `${failed} arquivos falharam`}
                </span>
              )
            )}
            <Button variant="secondary" disabled={sending} onClick={requestClose}>
              Cancelar
            </Button>
            <Button
              // A trava do clique duplo é o `sendingRef`; o disabled é o aviso.
              disabled={sending || items.length === 0}
              onClick={() => void sendAll()}
            >
              {sending ? (
                <>
                  <Spinner className="h-4 w-4" /> Enviando...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" /> {failed > 0 ? "Tentar de novo" : "Enviar"}
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
