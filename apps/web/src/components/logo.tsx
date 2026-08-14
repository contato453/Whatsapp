import { cn } from "@/lib/utils";

/**
 * Marca AZVCHAT: balão de conversa com o check, mais o logotipo.
 *
 * As cores da marca são próprias e ficam aqui, isoladas da paleta da
 * interface (`brand` no tailwind.config), que não muda.
 *
 * `tone` é o fundo onde a marca vai ser aplicada, não a cor dela:
 * - "light": fundo claro, "AZV" em azul-marinho.
 * - "dark": fundo escuro, "AZV" em branco.
 * O "CHAT" e o check ficam verdes nos dois casos.
 */

const NAVY = "#102A4C";
const GREEN = "#17BF6B";

export function LogoMark({
  tone = "light",
  className,
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  const outline = tone === "dark" ? "#ffffff" : NAVY;
  return (
    <svg viewBox="0 0 64 64" fill="none" className={className} aria-hidden="true">
      {/* Balão: retângulo arredondado com a ponta no canto inferior esquerdo */}
      <path
        d="M15 10h34a9 9 0 0 1 9 9v16a9 9 0 0 1-9 9H28L18 54V44h-3a9 9 0 0 1-9-9V19a9 9 0 0 1 9-9Z"
        stroke={outline}
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      {/* Check, transbordando o canto superior direito como no logotipo */}
      <path
        d="M30 30l8 8 18-24"
        stroke={GREEN}
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Reticências de "digitando" */}
      <circle cx="15" cy="37" r="2.4" fill={GREEN} />
      <circle cx="22.5" cy="37" r="2.4" fill={GREEN} />
      <circle cx="30" cy="37" r="2.4" fill={GREEN} />
    </svg>
  );
}

export function LogoWordmark({
  tone = "light",
  className,
}: {
  tone?: "light" | "dark";
  className?: string;
}) {
  return (
    <span className={cn("font-bold uppercase leading-none tracking-tight", className)}>
      <span style={{ color: tone === "dark" ? "#ffffff" : NAVY }}>AZV</span>
      <span style={{ color: GREEN }}>CHAT</span>
    </span>
  );
}

export function Logo({
  tone = "light",
  showTagline = false,
  className,
  markClassName,
  wordmarkClassName,
}: {
  tone?: "light" | "dark";
  showTagline?: boolean;
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark tone={tone} className={cn("h-8 w-8", markClassName)} />
      <div className="flex flex-col gap-1">
        <LogoWordmark tone={tone} className={cn("text-base", wordmarkClassName)} />
        {showTagline && (
          <span
            className={cn(
              "text-[9px] font-semibold uppercase tracking-[0.18em]",
              tone === "dark" ? "text-slate-300" : "text-slate-500",
            )}
          >
            Conecta · Atende · Resolve
          </span>
        )}
      </div>
    </div>
  );
}
