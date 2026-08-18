"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import {
  CONFIGURABLE_ROLES,
  USER_ROLE_LABELS,
  defaultPermission,
  isInvertedHierarchy,
  type ConfigurableRole,
  type PermissionActionDefinition,
} from "@azvchat/shared";
import { Tooltip } from "@/components/ui";
import type { RolePermissionOverrideDto } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Uma linha da tela de Permissões: a ação do catálogo e as duas chaves.
 *
 * A linha é GERADA a partir da definição — rótulo, explicação e padrões vêm
 * de `@azvchat/shared`. Ação nova no catálogo aparece aqui sozinha, sem
 * ninguém tocar nesta tela; foi para isso que o catálogo virou fonte única.
 */

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

interface Props {
  action: PermissionActionDefinition;
  /** Valor em edição por papel — já resolvido (configuração ou padrão). */
  values: Record<ConfigurableRole, boolean>;
  /** O que está gravado hoje, para dizer quem mudou e quando. */
  saved: Partial<Record<ConfigurableRole, RolePermissionOverrideDto>>;
  onToggle: (role: ConfigurableRole, allowed: boolean) => void;
  onReset: () => void;
}

export function PermissionRow({ action, values, saved, onToggle, onReset }: Props) {
  const alterada = CONFIGURABLE_ROLES.some(
    (role) => values[role] !== defaultPermission(action.key, role),
  );
  // Configuração estranha, mas não proibida: o dono pode ter um motivo. A
  // tela só avisa, porque quase sempre é engano de clique.
  const invertida = isInvertedHierarchy(values.agent, values.supervisor);

  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_5rem_5rem_2rem] items-start gap-3 border-t border-slate-100 px-4 py-3",
        alterada && "bg-amber-50/40",
      )}
    >
      <div>
        <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
          {action.label}
          {alterada && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
              Alterada
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{action.description}</p>

        {/* Quem mexeu na chave e quando — o registro mais sensível do sistema
            precisa ter dono e data à vista de quem abre a tela. */}
        {CONFIGURABLE_ROLES.filter((role) => saved[role]).map((role) => {
          const registro = saved[role];
          if (!registro) return null;
          return (
            <p key={role} className="mt-1 text-[11px] text-amber-700">
              {USER_ROLE_LABELS[role]}: alterado
              {registro.updatedBy ? ` por ${registro.updatedBy.name}` : ""} em{" "}
              {formatWhen(registro.updatedAt)}
            </p>
          );
        })}

        {invertida && (
          <p className="mt-1 flex items-start gap-1 text-[11px] text-orange-600">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            Liberado para Usuário e bloqueado para Supervisor — invertido em relação à
            hierarquia. Não é proibido, mas confira se é isso mesmo.
          </p>
        )}
      </div>

      {CONFIGURABLE_ROLES.map((role) => (
        <label
          key={role}
          className="flex justify-center pt-0.5"
          title={`${USER_ROLE_LABELS[role]}: ${action.label}`}
        >
          <input
            type="checkbox"
            checked={values[role]}
            onChange={(event) => onToggle(role, event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
            aria-label={`${USER_ROLE_LABELS[role]}: ${action.label}`}
          />
        </label>
      ))}

      <div className="flex justify-end pt-0.5">
        {alterada && (
          <Tooltip label="Restaurar o padrão desta ação">
            <button
              type="button"
              onClick={onReset}
              className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label={`Restaurar o padrão de: ${action.label}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
