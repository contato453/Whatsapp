"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- Button ----------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";

/**
 * O primário é a marca: fundo `brand-600` com texto branco dá 6,61:1 e o
 * hover `brand-700` dá 9,45:1 — os dois acima do 4,5:1 do WCAG AA. O verde
 * puro da marca (`brand-500`) NÃO entra aqui: com branco ele fica em 2,41:1.
 * Ele vale para detalhe e ícone, nunca para fundo de texto.
 */
const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50",
  secondary: "bg-slate-100 text-slate-800 hover:bg-slate-200",
  ghost: "text-slate-600 hover:bg-slate-100",
  outline: "border border-slate-300 text-slate-700 hover:bg-slate-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }
>(function Button({ className, variant = "primary", size = "md", ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm",
        buttonVariants[variant],
        className,
      )}
      {...props}
    />
  );
});

// ---------- Input / Textarea ----------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
          className,
        )}
        {...props}
      />
    );
  },
);

// ---------- Label / Field ----------

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

// ---------- Badge ----------

export function Badge({
  children,
  color,
  className,
  title,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        !color && "bg-slate-100 text-slate-700",
        className,
      )}
      style={color ? { backgroundColor: `${color}1a`, color } : undefined}
    >
      {children}
    </span>
  );
}

// ---------- Card ----------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white shadow-sm", className)}>
      {children}
    </div>
  );
}

// ---------- Avatar ----------

export function Avatar({
  name,
  src,
  size = "md",
  className,
}: {
  name: string;
  src?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-12 w-12 text-base" };
  const initialsText = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  if (src) {
    return <img src={src} alt={name} className={cn("rounded-full object-cover", sizes[size], className)} />;
  }
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700",
        sizes[size],
        className,
      )}
    >
      {initialsText || "?"}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      {/* max-h + rolagem interna: conteúdo alto não pode estourar a tela
          e ficar inacessível. O cabeçalho fica fixo durante a rolagem. */}
      <div
        className={cn(
          "flex max-h-[calc(100vh-2rem)] w-full flex-col rounded-xl bg-white shadow-xl",
          wide ? "max-w-2xl" : "max-w-md",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Fechar"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ---------- Tooltip ----------

/**
 * Dica de texto só com CSS — nada de biblioteca nova para isso.
 *
 * Aparece no hover e também no `focus-within`: item alcançado por Tab
 * precisa dizer o nome, senão a barra lateral recolhida vira uma coluna
 * de ícones mudos para quem navega por teclado.
 *
 * O conteúdo fica sempre no DOM (`aria-hidden` de fora não serve aqui):
 * quem usa leitor de tela lê o nome acessível do próprio gatilho, então
 * a dica é reforço visual e não pode duplicar leitura — por isso o
 * `role="tooltip"` sem `aria-describedby`.
 */
export function Tooltip({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("group/tooltip relative flex", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-focus-within/tooltip:opacity-100 group-hover/tooltip:opacity-100 motion-reduce:transition-none"
      >
        {label}
      </span>
    </span>
  );
}

// ---------- Spinner ----------

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600",
        className,
      )}
    />
  );
}

// ---------- Empty state ----------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Saída do beco: quando o vazio tem conserto, o botão vem junto do texto. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {icon && <div className="text-slate-300">{icon}</div>}
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {description && <p className="max-w-sm text-xs text-slate-400">{description}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

// ---------- MultiSelect ----------

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Segunda linha discreta (papel do usuário, cor do departamento...). */
  hint?: string;
}

export interface MultiSelectGroup {
  /** Nulo desenha o bloco sem cabeçalho — lista de um assunto só. */
  label: string | null;
  options: MultiSelectOption[];
}

/**
 * Seletor de VÁRIOS valores, com caixa de seleção e busca opcional.
 *
 * É o único componente de multisseleção da casa, usado pelos quatro filtros
 * da Inbox (atendimento, conexão, etiqueta, característica do cliente).
 * Quatro implementações separadas divergiriam no comportamento do teclado e
 * do clique fora, e a equipe sentiria a diferença sem saber nomear.
 *
 * **Os valores marcados aqui SOMAM entre si** (é um OU): quem consome decide
 * o que fazer com a lista, mas a leitura da tela é essa, e a caixa de seleção
 * é justamente o sinal de que dá para marcar mais de um.
 *
 * Sem biblioteca: a lista é um `div` posicionado, fechado por clique fora,
 * por `Esc` e por perda de foco. `blur` sozinho não serve, porque clicar numa
 * caixa de seleção tira o foco do botão e fecharia a lista no primeiro clique.
 */
export function MultiSelect({
  label,
  groups,
  selected,
  onChange,
  searchPlaceholder,
  emptyLabel,
  disabled,
  className,
}: {
  /** Texto do botão quando nada está marcado. */
  label: string;
  groups: MultiSelectGroup[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Presente = desenha o campo de busca no topo da lista. */
  searchPlaceholder?: string;
  /** Texto quando a busca não encontra nada. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fechar zera a busca: reabrir com o termo antigo esconderia metade da
  // lista e pareceria que os itens sumiram.
  useEffect(() => {
    if (!open) setTerm("");
  }, [open]);

  const busca = term.trim().toLowerCase();
  const visiveis = groups
    .map((group) => ({
      ...group,
      options: busca
        ? group.options.filter((option) => option.label.toLowerCase().includes(busca))
        : group.options,
    }))
    // A busca vale para os três blocos ao mesmo tempo, e bloco que ficou sem
    // nenhum item sai da lista em vez de virar um cabeçalho órfão.
    .filter((group) => group.options.length > 0);

  const rotulos = groups
    .flatMap((group) => group.options)
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);
  const resumo = rotulos.length === 0 ? label : rotulos.length === 1 ? rotulos[0] : `${rotulos[0]} +${rotulos.length - 1}`;

  function alternar(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div ref={boxRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((atual) => !atual)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          "flex w-full items-center justify-between gap-1 rounded-lg border px-1.5 py-1 text-left text-[11px] disabled:cursor-not-allowed disabled:opacity-60",
          rotulos.length > 0 ? "border-brand-500 font-medium text-brand-700" : "border-slate-200 text-slate-600",
        )}
      >
        {/* O rótulo é cortado por CSS: marcar dez itens não pode empurrar a
            barra de filtros para fora da coluna. */}
        <span className="truncate">{resumo}</span>
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute z-30 mt-1 max-h-72 w-full min-w-[13rem] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
        >
          {searchPlaceholder && (
            <div className="px-1.5 pb-1">
              <input
                autoFocus
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-700 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none"
              />
            </div>
          )}
          {visiveis.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-slate-400">{emptyLabel ?? "Nada encontrado."}</p>
          ) : (
            visiveis.map((group) => (
              <div key={group.label ?? "sem-bloco"}>
                {group.label && (
                  <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    {group.label}
                  </p>
                )}
                {group.options.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-2 px-2.5 py-1 text-[11px] text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(option.value)}
                      onChange={() => alternar(option.value)}
                      className="h-3.5 w-3.5 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.hint && <span className="shrink-0 text-[10px] text-slate-400">{option.hint}</span>}
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
