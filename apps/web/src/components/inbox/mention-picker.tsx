"use client";

import { AtSign, Users } from "lucide-react";
import {
  MENTION_ALL_HINT,
  MENTION_ALL_LABEL,
  MENTION_ALL_TOKEN,
  MENTION_MAX_PER_MESSAGE,
  MENTION_UNAVAILABLE_HINT,
  formatPhone,
  isMentionable,
  mentionToken,
  type DraftMention,
} from "@azvchat/shared";
import { Badge } from "@/components/ui";
import type { GroupDetailDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ParticipantAvatar } from "./conversation-avatar";

type Participant = GroupDetailDto["participants"][number];

/**
 * Seletor de participantes do "@", no mesmo padrão do autocomplete de "/"
 * das respostas rápidas (lista sobreposta ao composer, seta navega, Enter ou
 * Tab escolhe, Esc fecha).
 *
 * Ele vive fora do `inbox-shell` porque aquele arquivo já orquestra lista,
 * chat e composer inteiros; o que o shell mantém é só a cola — a consulta
 * digitada, o índice ativo e o que fazer ao escolher.
 */

/** Uma linha da lista: uma pessoa, ou o coletivo "@todos". */
export type MentionOption =
  | {
      kind: "all";
      /** Participantes que o coletivo consegue notificar. */
      mention: DraftMention;
      /** Quantos ficaram de fora por não terem telefone conhecido. */
      skipped: number;
    }
  | {
      kind: "participant";
      participant: Participant;
      /** `null` quando a pessoa não é mencionável (linha desabilitada). */
      mention: DraftMention | null;
    };

/** Sem acento e em minúsculas: "Joao" acha "João". */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function participantMention(participant: Participant): DraftMention | null {
  if (!isMentionable(participant)) return null;
  return {
    label: `@${participant.name}`,
    token: mentionToken(participant.phoneNumber),
    externalIds: [participant.externalContactId],
  };
}

/**
 * Monta as opções da lista. Fica aqui, e não no shell, para a navegação por
 * teclado e o que é desenhado saírem sempre da MESMA lista.
 *
 * Quem não é mencionável continua aparecendo, desabilitado: sumir com a
 * pessoa faria a equipe achar que ela não está no grupo.
 */
export function mentionOptions(
  participants: Participant[],
  query: string,
): MentionOption[] {
  const needle = fold(query);
  const matches = participants.filter((participant) => {
    if (needle.length === 0) return true;
    return (
      fold(participant.name).includes(needle) ||
      participant.phoneNumber.replace(/\D/g, "").includes(needle.replace(/\D/g, "")) &&
        /\d/.test(needle)
    );
  });

  const options: MentionOption[] = matches
    .slice(0, 12)
    .map((participant) => ({
      kind: "participant" as const,
      participant,
      mention: participantMention(participant),
    }));

  // "@todos" é a primeira linha, e só quando a busca combina com ela — quem
  // já digitou "@ma" está procurando a Marina, não o grupo inteiro.
  const mentionable = participants.filter(isMentionable);
  const showAll =
    mentionable.length > 0 &&
    (needle.length === 0 || fold(MENTION_ALL_TOKEN).slice(1).startsWith(needle));
  if (!showAll) return options;

  // Teto de menções por mensagem: em grupo grande o coletivo pega os
  // primeiros e a tela avisa quantos ficaram de fora.
  const included = mentionable.slice(0, MENTION_MAX_PER_MESSAGE);
  return [
    {
      kind: "all",
      mention: {
        label: MENTION_ALL_LABEL,
        // Não existe token de grupo no protocolo: o texto fica "@todos"
        // literal e quem notifica é a lista de identificadores.
        token: MENTION_ALL_TOKEN,
        externalIds: included.map((participant) => participant.externalContactId),
      },
      skipped: participants.length - included.length,
    },
    ...options,
  ];
}

export function MentionPicker({
  options,
  activeIndex,
  onHover,
  onSelect,
  hasParticipants,
}: {
  options: MentionOption[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (option: MentionOption) => void;
  /** false = o grupo ainda não foi sincronizado. */
  hasParticipants: boolean;
}) {
  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
      <p className="flex items-center gap-1.5 border-b border-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <AtSign className="h-3 w-3" /> Marcar participante — Enter insere, Esc fecha
      </p>
      {!hasParticipants && (
        <p className="px-3 py-2 text-xs text-slate-500">
          Participantes ainda não sincronizados. Use o botão de atualizar do painel de
          contexto, ao lado, e tente de novo.
        </p>
      )}
      {hasParticipants && options.length === 0 && (
        <p className="px-3 py-2 text-xs text-slate-500">Nenhum participante com esse nome.</p>
      )}
      {options.map((option, index) => {
        const disabled = option.kind === "participant" && option.mention === null;
        const active = index === activeIndex;
        if (option.kind === "all") {
          return (
            <button
              key="mention-all"
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(option);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "block w-full border-b border-slate-100 px-3 py-2 text-left",
                active ? "bg-brand-50" : "hover:bg-slate-50",
              )}
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-brand-700">
                <Users className="h-3.5 w-3.5" /> {MENTION_ALL_LABEL}
                <span className="font-normal text-slate-400">
                  {option.mention.externalIds.length}{" "}
                  {option.mention.externalIds.length === 1 ? "pessoa" : "pessoas"}
                </span>
              </p>
              <p className="text-xs text-slate-500">
                {MENTION_ALL_HINT}
                {option.skipped > 0 &&
                  ` · ${option.skipped} ${
                    option.skipped === 1 ? "ficará de fora" : "ficarão de fora"
                  }`}
              </p>
            </button>
          );
        }
        const { participant } = option;
        return (
          // A explicação de quem não pode ser marcado vai no `title` do
          // container: o tooltip do kit abre à direita e ficaria cortado pela
          // rolagem desta lista, que é estreita e sobreposta ao composer.
          <div key={participant.id} title={disabled ? MENTION_UNAVAILABLE_HINT : undefined}>
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(event) => {
              event.preventDefault();
              if (!disabled) onSelect(option);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left",
              disabled && "cursor-not-allowed opacity-50",
              active && !disabled ? "bg-brand-50" : !disabled && "hover:bg-slate-50",
            )}
          >
            <ParticipantAvatar
              participantId={participant.id}
              name={participant.name}
              hasAvatar={participant.hasAvatar}
              className="h-7 w-7 shrink-0 text-[9px]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-slate-700">
                {participant.name}
              </span>
              {/* Segunda linha só quando acrescenta informação: nome que já é
                  o telefone não precisa repetir o telefone embaixo. */}
              {!!participant.phoneNumber && !participant.nameIsPhone && (
                <span className="block truncate text-[11px] text-slate-400">
                  {formatPhone(participant.phoneNumber)}
                </span>
              )}
              {disabled && (
                <span className="block truncate text-[11px] text-slate-400">
                  Não pode ser marcado
                </span>
              )}
            </span>
            {participant.isAdmin && (
              <Badge className="shrink-0 bg-amber-50 text-amber-700">admin</Badge>
            )}
          </button>
          </div>
        );
      })}
    </div>
  );
}
