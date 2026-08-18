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
 * nestes seis valores e não herda um nome mentiroso.
 * - 50/100: fundo suave (linha ativa, chips, avatar sem foto);
 * - 400: bordas leves;
 * - 500: o verde exato da marca — detalhe, ícone, anel de foco;
 * - 600: fundo sólido com texto branco (bolha enviada, botão, aba ativa). O
 *   500 puro dá só 2,4:1 com branco e reprovaria no WCAG AA, então fundo
 *   sólido é sempre 600 (6,6:1 com branco) ou mais escuro;
 * - 700: hover e texto de marca sobre fundo claro (9,4:1 com branco).
 *
 * MARCA E ESTADO SÃO COISAS SEPARADAS, de propósito. O verde de estado
 * ("Aberto", "conectado") é `#16a34a` e mora em `@azvchat/shared`
 * (`CONVERSATION_STATUS_COLORS`, `CONNECTION_STATUS_COLORS`): ele responde
 * "como está o atendimento", enquanto o daqui responde "de quem é o produto".
 * Fundi-los faria a bolha enviada parecer um selo de status. O 600 é bem mais
 * escuro e saturado que o `#16a34a` justamente para os dois conviverem na
 * mesma tela sem se confundir; se um dia chegarem perto demais, escurece-se o
 * de marca — nunca o de estado.
 *
 * Este arquivo alimenta o `tailwind.config.ts` (classes `*-brand-*`) e também
 * os poucos pontos que precisam do hex cru, porque pintam com `style` inline:
 * acentos do dashboard e valor inicial de cor de departamento e etiqueta.
 */
export const BRAND_COLORS = {
  50: "#e9faf1",
  100: "#c6f2dc",
  400: "#2fcb80",
  500: "#17bf6b",
  600: "#0a6b3a",
  700: "#07512c",
} as const;

/** Azul-marinho da marca — o "AZV" do logotipo. */
export const BRAND_NAVY = "#102a4c";

/**
 * Rampa sequencial do mapa de calor do dashboard, na matiz exata da marca.
 *
 * É rampa de MAGNITUDE ("quanto"), nunca de estado ("como está") — e no mesmo
 * dashboard o `#16a34a` de estado aparece nas barras de recebidas e no anel de
 * conectividade. Por isso a rampa inteira foi escurecida e saturada até ficar
 * abaixo da luminância do verde de estado: nenhum degrau é mais claro do que
 * ele. Ajustar o verde de estado para caber seria o caminho errado.
 *
 * Degraus monótonos e perceptíveis (razão >= 1,4 entre vizinhos), e o mais
 * claro ainda separa da célula vazia `#f1f5f9` em 3,5:1.
 */
export const BRAND_HEATMAP_RAMP = ["#0f955c", "#0c784a", "#095e39", "#074329"] as const;
