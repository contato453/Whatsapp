"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, RotateCcw, Save, ShieldCheck } from "lucide-react";
import {
  CONFIGURABLE_ROLES,
  PERMISSION_AREAS,
  PERMISSION_AREA_DESCRIPTIONS,
  PERMISSION_AREA_LABELS,
  PERMISSION_ACTIONS,
  USER_ROLE_LABELS,
  defaultPermission,
  permissionActionsByArea,
  permissionOverrideKey,
  type ConfigurableRole,
  type PermissionAction,
} from "@azvchat/shared";
import { ApiError, permissionsApi } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { RolePermissionOverrideDto } from "@/lib/types";
import { Button, Card, Modal, Spinner } from "@/components/ui";
import { PermissionRow } from "@/components/permissions/permission-row";

/**
 * O que cada perfil PODE FAZER, configurado pelo dono do escritório.
 *
 * A tela inteira é GERADA a partir do catálogo de `@azvchat/shared`: áreas
 * viram seções, ações viram linhas e os padrões vêm de lá. Ação nova no
 * catálogo aparece aqui sozinha — este arquivo não tem lista de ação nenhuma,
 * e não pode passar a ter: seria a segunda lista que o desenho evita.
 *
 * Ela decide AÇÃO, nunca ALCANCE. Quem vê qual conversa continua saindo dos
 * números e departamentos vinculados a cada pessoa, na tela de Usuários — e
 * o aviso no topo diz isso, porque é a confusão natural de quem abre um menu
 * chamado "Permissões".
 */

type ValueMap = Record<string, boolean>;

/** O estado de fábrica: todo par (papel, ação) no padrão do catálogo. */
function defaults(): ValueMap {
  const map: ValueMap = {};
  for (const action of PERMISSION_ACTIONS) {
    for (const role of CONFIGURABLE_ROLES) {
      map[permissionOverrideKey(role, action.key)] = defaultPermission(action.key, role);
    }
  }
  return map;
}

/** Padrões com a configuração da organização por cima. */
function withOverrides(overrides: RolePermissionOverrideDto[]): ValueMap {
  const map = defaults();
  for (const override of overrides) {
    map[permissionOverrideKey(override.role, override.action)] = override.allowed;
  }
  return map;
}

export default function PermissionsPage() {
  const { user, setUser } = useAuth();
  const [saved, setSaved] = useState<RolePermissionOverrideDto[]>([]);
  const [values, setValues] = useState<ValueMap>(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    permissionsApi
      .list()
      .then((overrides) => {
        setSaved(overrides);
        setValues(withOverrides(overrides));
        setLoadError(null);
      })
      .catch((error: unknown) =>
        setLoadError(
          error instanceof ApiError ? error.message : "Não foi possível carregar as permissões.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /** O que está gravado hoje, indexado para a linha mostrar quem mudou. */
  const savedByKey = useMemo(() => {
    const map: Record<string, RolePermissionOverrideDto> = {};
    for (const override of saved) {
      map[permissionOverrideKey(override.role, override.action)] = override;
    }
    return map;
  }, [saved]);

  /**
   * O que mudou desde a última gravação. Salvamento é explícito e em bloco:
   * gravar a cada clique deixaria a organização passando por estados
   * intermediários que ninguém pediu.
   */
  const changes = useMemo(() => {
    const base = withOverrides(saved);
    return PERMISSION_ACTIONS.flatMap((action) =>
      CONFIGURABLE_ROLES.filter((role) => {
        const key = permissionOverrideKey(role, action.key);
        return values[key] !== base[key];
      }).map((role) => ({
        role,
        action: action.key as PermissionAction,
        allowed: values[permissionOverrideKey(role, action.key)] ?? false,
      })),
    );
  }, [values, saved]);

  const alteradasDoPadrao = useMemo(
    () =>
      PERMISSION_ACTIONS.reduce(
        (total, action) =>
          total +
          CONFIGURABLE_ROLES.filter(
            (role) =>
              values[permissionOverrideKey(role, action.key)] !==
              defaultPermission(action.key, role),
          ).length,
        0,
      ),
    [values],
  );

  const toggle = (role: ConfigurableRole, action: PermissionAction, allowed: boolean) => {
    setValues((current) => ({ ...current, [permissionOverrideKey(role, action)]: allowed }));
    setFeedback(null);
  };

  const resetAction = (action: PermissionAction) => {
    setValues((current) => {
      const next = { ...current };
      for (const role of CONFIGURABLE_ROLES) {
        next[permissionOverrideKey(role, action)] = defaultPermission(action, role);
      }
      return next;
    });
    setFeedback(null);
  };

  const resetAll = () => {
    setValues(defaults());
    setFeedback(null);
  };

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const overrides = await permissionsApi.save(changes);
      setSaved(overrides);
      setValues(withOverrides(overrides));
      setFeedback("Permissões salvas. Já valem na próxima ação de cada pessoa.");
      // O próprio admin pode ter mexido em chave que a tela dele usa. Ele
      // passa por cima de tudo, mas a lista da sessão é recarregada assim
      // mesmo para nenhuma tela ficar decidindo com dado velho.
      if (user) setUser({ ...user });
    } catch (error) {
      setSaveError(
        error instanceof ApiError ? error.message : "Não foi possível salvar as permissões.",
      );
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (loadError) {
    return <p className="p-8 text-sm text-red-600">{loadError}</p>;
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center gap-2.5">
        <ShieldCheck className="h-5 w-5 text-slate-400" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Permissões</h1>
          <p className="text-sm text-slate-500">
            O que cada perfil pode fazer no sistema. Vale para o escritório inteiro.
          </p>
        </div>
      </div>

      <div className="max-w-4xl space-y-4 pb-4">
        <p className="flex items-start gap-2 rounded-lg bg-sky-50 px-3.5 py-3 text-sm text-sky-800">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Esta tela define <strong className="font-semibold">o que cada perfil pode FAZER</strong>
            . O que cada pessoa <strong className="font-semibold">VÊ</strong> continua definido
            pelos números de WhatsApp e departamentos vinculados a ela, na tela de{" "}
            <strong className="font-semibold">Usuários</strong> — nenhuma chave aqui faz aparecer
            conversa que a pessoa já não enxergava. O{" "}
            <strong className="font-semibold">Administrador</strong> pode tudo, sempre, e por isso
            não tem coluna.
          </span>
        </p>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {alteradasDoPadrao === 0
              ? "Tudo no padrão do sistema."
              : `${alteradasDoPadrao} ${alteradasDoPadrao === 1 ? "chave está" : "chaves estão"} diferente${alteradasDoPadrao === 1 ? "" : "s"} do padrão.`}
          </p>
          <button
            type="button"
            onClick={resetAll}
            disabled={alteradasDoPadrao === 0}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Restaurar todos os padrões
          </button>
        </div>

        {PERMISSION_AREAS.map((area) => {
          const acoes = permissionActionsByArea(area);
          if (acoes.length === 0) return null;
          return (
            <Card key={area} className="overflow-hidden p-0">
              <div className="px-4 pb-3 pt-4">
                <h2 className="text-sm font-semibold text-slate-900">
                  {PERMISSION_AREA_LABELS[area]}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {PERMISSION_AREA_DESCRIPTIONS[area]}
                </p>
              </div>

              <div className="grid grid-cols-[1fr_5rem_5rem_2rem] gap-3 bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <span>Ação</span>
                {CONFIGURABLE_ROLES.map((role) => (
                  <span key={role} className="text-center">
                    {USER_ROLE_LABELS[role]}
                  </span>
                ))}
                <span />
              </div>

              {acoes.map((action) => (
                <PermissionRow
                  key={action.key}
                  action={action}
                  values={{
                    agent: values[permissionOverrideKey("agent", action.key)] ?? false,
                    supervisor: values[permissionOverrideKey("supervisor", action.key)] ?? false,
                  }}
                  saved={{
                    agent: savedByKey[permissionOverrideKey("agent", action.key)],
                    supervisor: savedByKey[permissionOverrideKey("supervisor", action.key)],
                  }}
                  onToggle={(role, allowed) => toggle(role, action.key, allowed)}
                  onReset={() => resetAction(action.key)}
                />
              ))}
            </Card>
          );
        })}

        <div className="flex items-center gap-3">
          <Button onClick={() => setConfirming(true)} disabled={saving || changes.length === 0}>
            {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {changes.length === 0
              ? "Nada para salvar"
              : `Salvar ${changes.length} ${changes.length === 1 ? "alteração" : "alterações"}`}
          </Button>
          {feedback && <span className="text-sm text-emerald-600">{feedback}</span>}
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
        </div>
      </div>

      {/* Confirmação explícita: é a configuração que abre ou fecha o sistema
          para a equipe inteira, e a lista mostra exatamente o que vai mudar. */}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Confirmar alteração de permissões"
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            As mudanças abaixo valem para todo mundo do perfil, já na próxima ação de cada pessoa —
            ninguém precisa sair e entrar de novo.
          </p>
          <ul className="thin-scroll max-h-64 space-y-1.5 overflow-y-auto rounded-lg bg-slate-50 p-3 text-sm">
            {changes.map((change) => {
              const action = PERMISSION_ACTIONS.find((item) => item.key === change.action);
              return (
                <li key={`${change.role}:${change.action}`} className="text-slate-700">
                  <strong className="font-medium">{USER_ROLE_LABELS[change.role]}</strong>{" "}
                  {change.allowed ? (
                    <span className="text-emerald-700">passa a poder</span>
                  ) : (
                    <span className="text-red-700">deixa de poder</span>
                  )}{" "}
                  {(action?.label ?? change.action).toLowerCase()}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Spinner className="h-4 w-4" /> : null}
              Confirmar e salvar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
