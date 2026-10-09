"use client";

import { useMemo, useState } from "react";
import { CalendarOff, Plus, Trash2 } from "lucide-react";
import {
  HOLIDAY_DATE_PATTERN,
  HOLIDAY_KIND_LABELS,
  MAX_CUSTOM_HOLIDAYS,
  MAX_HOLIDAY_NAME_LENGTH,
  holidaysForYear,
  type CustomHoliday,
  type HolidayKind,
  type HolidaySettings,
} from "@azvchat/shared";
import { Button, Card, Input } from "@/components/ui";

/**
 * Bloco "Feriados" da tela de Parâmetros de atendimento.
 *
 * Fica fora do `page.tsx` porque a página já carrega quatro blocos e este é o
 * único com lista editável. O estado continua sendo da página (ela grava tudo
 * num botão só): aqui só se desenha e se avisa o que mudou.
 *
 * A prévia do ano sai de `holidaysForYear`, a MESMA função que o cálculo de
 * atraso consulta na API — o que a tela mostra é exatamente o que deixa de
 * contar como atraso.
 */

const KIND_STYLES: Record<HolidayKind, string> = {
  national: "bg-slate-100 text-slate-700",
  optional: "bg-amber-50 text-amber-700",
  custom: "bg-brand-100 text-brand-700",
};

/** "2026-12-25" → "25/12/2026 (sexta-feira)". */
function formatHolidayDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year!, month! - 1, day!)),
  );
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year} (${weekday})`;
}

/** Confere o que a API confere, para o erro aparecer na linha certa. */
export function validateCustomHolidays(custom: CustomHoliday[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const exactDates = new Set<string>();
  const recurringDays = new Set<string>();
  const allDays = new Set<string>();
  custom.forEach((holiday, index) => {
    if (!HOLIDAY_DATE_PATTERN.test(holiday.date)) {
      errors[index] = "Informe a data.";
      return;
    }
    if (!holiday.name.trim()) {
      errors[index] = "Informe o nome do feriado.";
      return;
    }
    const monthDay = holiday.date.slice(5);
    const duplicate = holiday.recurring
      ? allDays.has(monthDay)
      : exactDates.has(holiday.date) || recurringDays.has(monthDay);
    if (duplicate) errors[index] = "Esta data já está na lista.";
    exactDates.add(holiday.date);
    allDays.add(monthDay);
    if (holiday.recurring) recurringDays.add(monthDay);
  });
  return errors;
}

export function HolidaysCard({
  value,
  errors,
  onChange,
}: {
  value: HolidaySettings;
  errors: Record<number, string>;
  onChange: (next: HolidaySettings) => void;
}) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const preview = useMemo(() => holidaysForYear(value, year), [value, year]);

  function updateCustom(index: number, patch: Partial<CustomHoliday>): void {
    onChange({
      ...value,
      custom: value.custom.map((holiday, position) =>
        position === index ? { ...holiday, ...patch } : holiday,
      ),
    });
  }

  function addCustom(): void {
    onChange({ ...value, custom: [...value.custom, { date: "", name: "", recurring: false }] });
  }

  function removeCustom(index: number): void {
    onChange({ ...value, custom: value.custom.filter((_, position) => position !== index) });
  }

  return (
    <Card className="p-6">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <CalendarOff className="h-4 w-4 text-slate-400" />
        Feriados
      </h2>
      <p className="mb-4 text-sm text-slate-500">
        Feriado é dia fechado: o tempo de resposta não corre, então ninguém entra em atraso e o
        Quality não cobra a espera. Vale também para a mensagem de fora do expediente, o
        follow-up e os disparos. Não muda o horário de login.
      </p>

      <div className="mb-5 space-y-3">
        <label className="flex items-start gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={value.nationalEnabled}
            onChange={(event) => onChange({ ...value, nationalEnabled: event.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          />
          <span>
            <span className="font-medium text-slate-900">Feriados nacionais</span>
            <span className="block text-xs text-slate-500">
              Calculados todo ano, sem precisar cadastrar, inclusive a Sexta-feira da Paixão.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={value.optionalEnabled}
            onChange={(event) => onChange({ ...value, optionalEnabled: event.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
          />
          <span>
            <span className="font-medium text-slate-900">Pontos facultativos</span>
            <span className="block text-xs text-slate-500">
              Carnaval (segunda e terça) e Corpus Christi. Ligue se o escritório fecha nesses dias.
            </span>
          </span>
        </label>
      </div>

      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-900">Feriados do escritório</h3>
          <Button
            variant="secondary"
            onClick={addCustom}
            disabled={value.custom.length >= MAX_CUSTOM_HOLIDAYS}
          >
            <Plus className="h-4 w-4" />
            Adicionar data
          </Button>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Feriado estadual ou municipal, recesso de fim de ano, ponte. Marque “Todo ano” para o
          que repete no mesmo dia (aniversário da cidade, por exemplo).
        </p>
        {value.custom.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
            Nenhuma data própria cadastrada.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 border-y border-slate-100">
            {value.custom.map((holiday, index) => (
              <div key={index} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    aria-label={`Feriado ${index + 1}: data`}
                    value={holiday.date}
                    aria-invalid={errors[index] !== undefined}
                    onChange={(event) => updateCustom(index, { date: event.target.value })}
                    className="w-40"
                  />
                  <Input
                    aria-label={`Feriado ${index + 1}: nome`}
                    placeholder="Nome (ex.: Aniversário da cidade)"
                    maxLength={MAX_HOLIDAY_NAME_LENGTH}
                    value={holiday.name}
                    aria-invalid={errors[index] !== undefined}
                    onChange={(event) => updateCustom(index, { name: event.target.value })}
                    className="min-w-[12rem] flex-1"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={holiday.recurring}
                      onChange={(event) => updateCustom(index, { recurring: event.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/30"
                    />
                    Todo ano
                  </label>
                  <button
                    type="button"
                    onClick={() => removeCustom(index)}
                    aria-label={`Remover feriado ${index + 1}`}
                    title="Remover"
                    className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {errors[index] && <p className="mt-1 text-xs text-red-600">{errors[index]}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-900">Dias fechados em {year}</h3>
          <select
            value={year}
            aria-label="Ano da prévia"
            onChange={(event) => setYear(Number(event.target.value))}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900"
          >
            {[currentYear - 1, currentYear, currentYear + 1].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        {preview.length === 0 ? (
          <p className="text-xs text-slate-400">
            Nenhum feriado neste ano: o atraso conta todos os dias ativos do expediente.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 text-sm">
            {preview.map((holiday) => (
              <li
                key={`${holiday.kind}-${holiday.date}-${holiday.name}`}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5"
              >
                <span className="text-slate-700">
                  <span className="tabular-nums text-slate-500">{formatHolidayDate(holiday.date)}</span>{" "}
                  · {holiday.name || "Sem nome"}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_STYLES[holiday.kind]}`}
                >
                  {HOLIDAY_KIND_LABELS[holiday.kind]}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-400">
          A prévia já mostra o que está na tela; o cálculo passa a valer depois de salvar.
        </p>
      </div>
    </Card>
  );
}
