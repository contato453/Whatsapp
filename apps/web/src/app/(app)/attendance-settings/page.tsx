"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, LogIn, Save, SlidersHorizontal, TriangleAlert } from "lucide-react";
import {
  DEFAULT_ATTENDANCE_SETTINGS,
  LOGIN_SCHEDULE_WARNING_MINUTES,
  RESPONSE_LIMIT_MAX_MINUTES,
  RESPONSE_LIMIT_MIN_MINUTES,
  RESPONSE_LIMIT_USUAL_MAX_MINUTES,
  RESPONSE_LIMIT_USUAL_MIN_MINUTES,
  TIME_OF_DAY_PATTERN,
  WEEKDAY_LABELS,
  type AttendanceSettings,
  type BusinessHours,
  type LoginHours,
  type Weekday,
} from "@azvchat/shared";
import { ApiError, attendanceSettingsApi } from "@/lib/api";
import { Button, Card, Field, Input, Spinner } from "@/components/ui";

/**
 * Fusos oferecidos quando o navegador não sabe listar os dele. Cobrem o
 * Brasil inteiro, que é o caso real do escritório — a API aceita qualquer
 * fuso válido do runtime, então isto é só conveniência da tela.
 */
const FALLBACK_TIMEZONES = [
  "America/Sao_Paulo",
  "America/Bahia",
  "America/Fortaleza",
  "America/Recife",
  "America/Belem",
  "America/Manaus",
  "America/Cuiaba",
  "America/Campo_Grande",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Noronha",
];

function listTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const values = intl.supportedValuesOf?.("timeZone");
    if (values && values.length > 0) return values;
  } catch {
    // Runtime sem `supportedValuesOf`: a lista curta resolve o caso real.
  }
  return FALLBACK_TIMEZONES;
}

/** Minutos desde a meia-noite — mesma conta da API, para a tela barrar antes. */
function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Erro por dia da semana, indexado pelo próprio dia. */
type WeekErrors = Partial<Record<Weekday, string>>;

interface FieldErrors {
  responseLimitMinutes?: string;
  businessHours: WeekErrors;
  loginHours: WeekErrors;
}

const NO_ERRORS: FieldErrors = { businessHours: {}, loginHours: {} };

/**
 * Uma semana vale quando todo dia ativo fecha. Serve para o expediente e
 * para a janela de login: a checagem é a mesma, e ter duas cópias faria uma
 * delas ficar para trás.
 */
function validateWeek(days: Array<BusinessHours | LoginHours>): WeekErrors {
  const errors: WeekErrors = {};
  for (const day of days) {
    if (!TIME_OF_DAY_PATTERN.test(day.startTime) || !TIME_OF_DAY_PATTERN.test(day.endTime)) {
      errors[day.weekday] = "Horário inválido — use o formato HH:MM.";
      continue;
    }
    // Dia desligado não acumula tempo nenhum (nem libera login): horário
    // invertido ali é inofensivo e não vale travar a gravação da semana.
    if (day.active && minutesOfDay(day.endTime) <= minutesOfDay(day.startTime)) {
      errors[day.weekday] = "A hora de fim precisa ser maior que a de início.";
    }
  }
  return errors;
}

/**
 * Confere o que a API confere, para o erro aparecer no campo em vez de
 * voltar como mensagem genérica de 400.
 */
function validate(
  limitInput: string,
  businessHours: BusinessHours[],
  loginHours: LoginHours[],
): FieldErrors {
  const errors: FieldErrors = {
    businessHours: validateWeek(businessHours),
    loginHours: validateWeek(loginHours),
  };
  const limit = Number(limitInput);
  if (!Number.isInteger(limit)) {
    errors.responseLimitMinutes = "Informe um número inteiro de minutos.";
  } else if (limit < RESPONSE_LIMIT_MIN_MINUTES || limit > RESPONSE_LIMIT_MAX_MINUTES) {
    errors.responseLimitMinutes = `O limite precisa ficar entre ${RESPONSE_LIMIT_MIN_MINUTES} e ${RESPONSE_LIMIT_MAX_MINUTES} minutos.`;
  }
  return errors;
}

function hasErrors(errors: FieldErrors): boolean {
  return (
    errors.responseLimitMinutes !== undefined ||
    Object.keys(errors.businessHours).length > 0 ||
    Object.keys(errors.loginHours).length > 0
  );
}

interface WeekScheduleProps {
  days: Array<BusinessHours | LoginHours>;
  errors: WeekErrors;
  /** Rótulo do dia desligado — muda de sentido entre expediente e login. */
  inactiveLabel: string;
  /**
   * Prefixo do rótulo acessível. Sem ele as duas semanas da tela teriam
   * campos com o mesmo nome ("Segunda-feira: início") e quem navega por
   * leitor de tela não saberia qual está editando.
   */
  fieldPrefix: string;
  onChange: (weekday: Weekday, patch: Partial<BusinessHours>) => void;
}

/** A semana editável, usada pelo expediente e pela janela de login. */
function WeekSchedule({
  days,
  errors,
  inactiveLabel,
  fieldPrefix,
  onChange,
}: WeekScheduleProps) {
  return (
    <div className="divide-y divide-slate-100 border-t border-slate-100">
      {days.map((day) => {
        const error = errors[day.weekday];
        return (
          <div key={day.weekday} className="py-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex w-44 shrink-0 items-center gap-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={day.active}
                  onChange={(event) => onChange(day.weekday, { active: event.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
                />
                <span className={day.active ? "font-medium text-slate-900" : ""}>
                  {WEEKDAY_LABELS[day.weekday]}
                </span>
              </label>
              {day.active ? (
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-slate-400" />
                  <Input
                    type="time"
                    aria-label={`${fieldPrefix} ${WEEKDAY_LABELS[day.weekday]}: início`}
                    value={day.startTime}
                    aria-invalid={error !== undefined}
                    onChange={(event) => onChange(day.weekday, { startTime: event.target.value })}
                    className="w-32"
                  />
                  <span className="text-xs text-slate-400">até</span>
                  <Input
                    type="time"
                    aria-label={`${fieldPrefix} ${WEEKDAY_LABELS[day.weekday]}: fim`}
                    value={day.endTime}
                    aria-invalid={error !== undefined}
                    onChange={(event) => onChange(day.weekday, { endTime: event.target.value })}
                    className="w-32"
                  />
                </div>
              ) : (
                // Dia desligado esconde os horários: campo visível mas sem
                // efeito só confunde quem está configurando.
                <span className="text-xs text-slate-400">{inactiveLabel}</span>
              )}
            </div>
            {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

export default function AttendanceSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS);

  // O limite fica como texto enquanto a pessoa digita: campo numérico
  // controlado por número apaga o que ela escreveu ao limpar o campo.
  const [limitInput, setLimitInput] = useState(
    String(DEFAULT_ATTENDANCE_SETTINGS.responseLimitMinutes),
  );
  const [timezone, setTimezone] = useState(DEFAULT_ATTENDANCE_SETTINGS.timezone);
  const [businessHours, setBusinessHours] = useState<BusinessHours[]>(
    DEFAULT_ATTENDANCE_SETTINGS.businessHours,
  );
  const [loginRestrictionEnabled, setLoginRestrictionEnabled] = useState(
    DEFAULT_ATTENDANCE_SETTINGS.loginRestrictionEnabled,
  );
  const [loginHours, setLoginHours] = useState<LoginHours[]>(
    DEFAULT_ATTENDANCE_SETTINGS.loginHours,
  );

  const timezones = useMemo(listTimezones, []);

  useEffect(() => {
    attendanceSettingsApi
      .get()
      .then((settings) => {
        setLimitInput(String(settings.responseLimitMinutes));
        setTimezone(settings.timezone);
        setBusinessHours(settings.businessHours);
        setLoginRestrictionEnabled(settings.loginRestrictionEnabled);
        setLoginHours(settings.loginHours);
      })
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : "Falha ao carregar os parâmetros"),
      )
      .finally(() => setLoading(false));
  }, []);

  const limit = Number(limitInput);
  const outsideUsualRange =
    Number.isInteger(limit) &&
    limit >= RESPONSE_LIMIT_MIN_MINUTES &&
    limit <= RESPONSE_LIMIT_MAX_MINUTES &&
    (limit < RESPONSE_LIMIT_USUAL_MIN_MINUTES || limit > RESPONSE_LIMIT_USUAL_MAX_MINUTES);

  function updateDay(weekday: Weekday, patch: Partial<BusinessHours>): void {
    setSaved(false);
    setBusinessHours((current) =>
      current.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day)),
    );
  }

  function updateLoginDay(weekday: Weekday, patch: Partial<LoginHours>): void {
    setSaved(false);
    setLoginHours((current) =>
      current.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day)),
    );
  }

  async function handleSave(): Promise<void> {
    // Nada de salvar a cada tecla: a validação e a gravação acontecem aqui,
    // no botão, porque isto é regra do escritório e não preferência pessoal.
    const found = validate(limitInput, businessHours, loginHours);
    setErrors(found);
    setSaveError(null);
    setSaved(false);
    if (hasErrors(found)) return;

    const payload: AttendanceSettings = {
      responseLimitMinutes: Number(limitInput),
      timezone,
      businessHours,
      loginRestrictionEnabled,
      loginHours,
    };
    setSaving(true);
    try {
      const settings = await attendanceSettingsApi.save(payload);
      setLimitInput(String(settings.responseLimitMinutes));
      setTimezone(settings.timezone);
      setBusinessHours(settings.businessHours);
      setLoginRestrictionEnabled(settings.loginRestrictionEnabled);
      setLoginHours(settings.loginHours);
      setSaved(true);
    } catch (err) {
      setSaveError(
        err instanceof ApiError && err.status === 403
          ? "Só supervisores e administradores podem alterar estes parâmetros."
          : err instanceof Error
            ? err.message
            : "Falha ao salvar",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (loadError) {
    return <p className="p-8 text-sm text-red-600">{loadError}</p>;
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center gap-2.5">
        <SlidersHorizontal className="h-5 w-5 text-slate-400" />
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Parâmetros de atendimento</h1>
          <p className="text-sm text-slate-500">
            Valem para o escritório inteiro e alimentam os indicadores do dashboard.
          </p>
        </div>
      </div>

      <div className="max-w-2xl space-y-4">
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Tempo de resposta
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            Um atendimento entra como atrasado depois deste tempo sem resposta, contando só
            dentro do expediente.
          </p>
          <div className="max-w-[14rem]">
            <Field label="Limite em minutos">
              <Input
                type="number"
                inputMode="numeric"
                min={RESPONSE_LIMIT_MIN_MINUTES}
                max={RESPONSE_LIMIT_MAX_MINUTES}
                value={limitInput}
                aria-invalid={errors.responseLimitMinutes !== undefined}
                onChange={(event) => {
                  setLimitInput(event.target.value);
                  setSaved(false);
                }}
              />
            </Field>
          </div>
          {errors.responseLimitMinutes && (
            <p className="mt-1.5 text-xs text-red-600">{errors.responseLimitMinutes}</p>
          )}
          {outsideUsualRange && !errors.responseLimitMinutes && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              Valor fora do usual (entre {RESPONSE_LIMIT_USUAL_MIN_MINUTES} e{" "}
              {RESPONSE_LIMIT_USUAL_MAX_MINUTES} minutos). Dá para salvar assim mesmo.
            </p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Expediente
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            O tempo de resposta só corre dentro destes horários. Dia desligado não acumula
            atraso nenhum. Feriado não é tratado e conta como dia normal.
          </p>

          <div className="mb-5 max-w-sm">
            <Field label="Fuso horário">
              <select
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                  setSaved(false);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              >
                {/* O fuso salvo pode não estar na lista do navegador atual:
                    incluí-lo evita a tela trocar a configuração sem querer. */}
                {!timezones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <WeekSchedule
            days={businessHours}
            errors={errors.businessHours}
            inactiveLabel="Sem atendimento"
            fieldPrefix="Expediente"
            onChange={updateDay}
          />
        </Card>

        <Card className="p-6">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            <LogIn className="h-4 w-4 text-slate-400" />
            Horário de login
          </h2>
          <p className="mb-4 text-sm text-slate-500">
            Limita os dias e horários em que a equipe consegue entrar no sistema. Vale só para
            quem tem papel de <strong className="font-medium">Usuário</strong> — supervisores e
            administradores entram sempre, senão um dia desligado por engano trancaria o
            escritório inteiro do lado de fora. O fuso é o mesmo escolhido acima.
          </p>

          <label className="mb-4 flex items-start gap-2.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={loginRestrictionEnabled}
              onChange={(event) => {
                setLoginRestrictionEnabled(event.target.checked);
                setSaved(false);
              }}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
            />
            <span>
              <span className="font-medium text-slate-900">Restringir o horário de login</span>
              <span className="block text-xs text-slate-500">
                Desligado, todo mundo entra a qualquer hora e os horários abaixo ficam só
                guardados.
              </span>
            </span>
          </label>

          {loginRestrictionEnabled && (
            <p className="mb-4 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Fora desta faixa, quem é Usuário não entra — e quem já está dentro é avisado{" "}
              {LOGIN_SCHEDULE_WARNING_MINUTES} minutos antes e tem a sessão encerrada no
              fechamento. A autorização é feita aqui: abrir o dia ou esticar o horário libera na
              hora, sem reiniciar nada.
            </p>
          )}

          <WeekSchedule
            days={loginHours}
            errors={errors.loginHours}
            inactiveLabel="Sem login"
            fieldPrefix="Login"
            onChange={updateLoginDay}
          />
        </Card>

        <div className="flex items-center gap-3 pb-4">
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? "Salvando..." : "Salvar parâmetros"}
          </Button>
          {saved && <span className="text-sm text-emerald-600">Parâmetros salvos.</span>}
          {saveError && <span className="text-sm text-red-600">{saveError}</span>}
        </div>
      </div>
    </div>
  );
}
