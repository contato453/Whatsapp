"use client";

/**
 * Miniatura da série do período dentro do card de mensagens.
 *
 * É decorativa por contrato — daí o `aria-hidden`, sem eixo e sem tooltip: o
 * total exato está no próprio card, e o valor de cada dia mora no gráfico
 * "Mensagens por dia" logo abaixo, que tem o gêmeo em tabela. Duplicar a
 * interação aqui criaria um segundo lugar respondendo à mesma pergunta.
 */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  // Com um ponto só (período "Hoje") não existe linha a desenhar — o card
  // fica só com o número, que é o que o dia único tem a dizer.
  if (values.length < 2) return null;

  const WIDTH = 120;
  const HEIGHT = 34;
  const PAD = 3;
  const peak = Math.max(...values, 1);
  const step = (WIDTH - PAD * 2) / (values.length - 1);
  const points = values.map((value, index) => ({
    x: PAD + index * step,
    y: PAD + (HEIGHT - PAD * 2) * (1 - value / peak),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const area = `${line} L${last.x},${HEIGHT} L${first.x},${HEIGHT} Z`;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // `preserveAspectRatio="none"` deixa a miniatura ocupar a largura do
      // card; o `vectorEffect` segura a espessura da linha nesse estica.
      preserveAspectRatio="none"
      className="h-9 w-full"
      aria-hidden
    >
      <path d={area} fill={color} opacity={0.12} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
