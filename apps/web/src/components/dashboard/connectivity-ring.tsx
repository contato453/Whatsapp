"use client";

/** Verde de "conectado" — o mesmo de CONNECTION_STATUS_COLORS no shared. */
const CONNECTED_COLOR = "#16a34a";

/**
 * Anel de conectividade: quantos números estão no ar sobre o total visível.
 *
 * A fração escrita no centro é o dado; o arco é só a leitura rápida — por
 * isso o SVG inteiro é uma imagem com rótulo falado, e não um gráfico
 * interativo. A quebra por status de quem está fora do ar fica nos cards ao
 * lado, então aqui uma cor basta.
 */
export function ConnectivityRing({ connected, total }: { connected: number; total: number }) {
  const RADIUS = 26;
  const STROKE = 7;
  const SIZE = (RADIUS + STROKE) * 2;
  const circumference = 2 * Math.PI * RADIUS;
  const fraction = total > 0 ? connected / total : 0;

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="h-16 w-16 shrink-0"
      role="img"
      aria-label={`${connected} de ${total} números conectados`}
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth={STROKE}
      />
      {fraction > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke={CONNECTED_COLOR}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
          // Começa no topo, como um relógio — sem o giro o arco nasce às 3h.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      )}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-slate-900 font-bold tabular-nums"
        fontSize={15}
      >
        {connected}
        <tspan className="fill-slate-400 font-medium" fontSize={10}>
          /{total}
        </tspan>
      </text>
    </svg>
  );
}
