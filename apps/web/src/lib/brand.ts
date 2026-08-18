/**
 * Paleta de MARCA do AZVCHAT — fonte única, em um lugar só.
 *
 * O verde é `#17BF6B`, extraído do próprio logotipo: é o hex do check, das
 * reticências e do "CHAT" em `components/logo.tsx` e em `app/icon.svg`. Antes
 * daqui saía indigo, que não era cor de marca nenhuma e fazia o produto não
 * parecer do AZVCHAT. O azul-marinho `#102A4C` completa a marca e continua
 * morando em `components/logo.tsx`, onde é usado.
 *
 * Os nomes são por PAPEL, não por cor: quem trocar a marca de novo mexe só
 * nestes sete valores e não herda um nome mentiroso.
 * - 50/100: fundo suave (linha ativa, chips, avatar sem foto);
 * - 400: bordas leves;
 * - 500: o verde exato da marca — detalhe, ícone, anel de foco;
 * - 550: fundo sólido da TELA DE CONVERSAS (bolha enviada, aba ativa do
 *   composer, badge de não lidas, botão de gravar áudio). É um degrau mais
 *   claro que o 600 porque ali o verde cobre área grande e o tom escuro
 *   pesava na leitura do chat; 5,00:1 com branco, ainda acima do AA. É o
 *   **mais claro possível** mantendo texto branco: acima disto o branco cai
 *   abaixo de 4,5:1 e a legenda dentro da bolha deixaria de passar;
 * - 600: fundo sólido do resto do sistema (botão primário, hover do 550) e
 *   texto de marca sobre claro. O 500 puro dá só 2,4:1 com branco e
 *   reprovaria no WCAG AA, então fundo sólido nunca é o 500;
 * - 700: hover do botão primário e texto de marca sobre claro (9,4:1).
 *
 * MARCA E ESTADO SÃO COISAS SEPARADAS, de propósito. O verde de estado
 * ("Aberto", "conectado") é `#16a34a` e mora em `@azvchat/shared`
 * (`CONVERSATION_STATUS_COLORS`, `CONNECTION_STATUS_COLORS`): ele responde
 * "como está o atendimento", enquanto o daqui responde "de quem é o produto".
 * Fundi-los faria a bolha enviada parecer um selo de status. O 600 é bem mais
 * escuro e saturado que o `#16a34a` justamente para os dois conviverem na
 * mesma tela sem se confundir; se um dia chegarem perto demais, escurece-se o
 * de marca — nunca o de estado. O 550 da tela de Conversas é o ponto em que
 * essa distância fica mais curta (1,52 contra o `#16a34a`), e ela se sustenta
 * porque ali o verde é superfície cheia e o estado é pílula clara com texto
 * colorido: são formas diferentes, não só cores diferentes.
 *
 * Este arquivo alimenta o `tailwind.config.ts` (classes `*-brand-*`) e também
 * o ponto que precisa do hex cru, porque pinta com `style` inline: o valor
 * inicial de cor de departamento e de etiqueta. O Dashboard NÃO consome esta
 * paleta — ele fica no indigo de propósito, e o porquê está em
 * `app/(app)/dashboard/page.tsx`.
 */
export const BRAND_COLORS = {
  50: "#e9faf1",
  100: "#c6f2dc",
  400: "#2fcb80",
  500: "#17bf6b",
  550: "#0c8049",
  600: "#0a6b3a",
  700: "#07512c",
} as const;

/** Azul-marinho da marca — o "AZV" do logotipo. */
export const BRAND_NAVY = "#102a4c";
