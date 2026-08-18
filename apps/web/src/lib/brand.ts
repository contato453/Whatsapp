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

/**
 * Cores da BOLHA ENVIADA na tela de Conversas — o verde claro do WhatsApp,
 * pedido explicitamente para o chat: fundo pálido e letra escura, e não fundo
 * verde forte com letra branca.
 *
 * Ficam separadas de `BRAND_COLORS` porque não são a marca: são a convenção
 * visual do próprio WhatsApp, que o atendente já lê há anos como "esta saiu
 * daqui". Trocar a marca não deve repintar o chat, e vice-versa.
 *
 * O `sent` é o hex do aplicativo. Os outros dois **não** copiam o WhatsApp ao
 * pé da letra: o cinza dele (`#667781`) dá 4,19:1 sobre esse fundo e o horário
 * é texto de 10px, que precisa de 4,5:1; o azul do check duplo (`#53bdeb`) dá
 * 1,92:1, longe do 3:1 de ícone. Escurecemos os dois o mínimo para passarem,
 * mantendo o tom reconhecível.
 * - `sent` sobre `sent-text`: 15,75:1
 * - `sent` sobre `sent-meta` (horário, citação, legenda): 4,83:1
 */
export const CHAT_COLORS = {
  sent: "#d9fdd3",
  "sent-text": "#111b21",
  "sent-meta": "#5d6d78",
} as const;
