/**
 * MINIMIZAÇÃO DE DADOS ANTES DA AVALIAÇÃO.
 *
 * Por que mascarar: o material da avaliação sai do escritório para o provedor
 * de IA, e o que ele precisa para julgar um atendimento é o COMO se falou, não
 * o CPF de quem falou. Nada aqui melhora a nota; tudo aqui reduz o que
 * atravessa. A regra é a mesma que vale para log em todo o repositório, só
 * aplicada a um material que é montado de propósito para sair.
 *
 * Por que é UM PASSO DEPOIS da transcrição: o mascaramento age sobre TEXTO, e
 * é justamente no ÁUDIO que o cliente dita CPF, CNPJ, telefone e chave Pix
 * ("meu CPF é 123..."). Áudio mandado direto para a etapa de avaliação pularia
 * esta proteção exatamente onde ela mais importa — por isso transcrever e
 * avaliar nunca são a mesma chamada.
 *
 * O que NÃO é mascarado, de propósito: a transcrição GRAVADA no banco fica
 * íntegra. Ela é conteúdo da conversa, que o administrador já tem direito de
 * ler, e mascará-la na origem apagaria o dado do cliente do próprio histórico
 * do escritório. A máscara vale só para o que SAI para a avaliação.
 */

export const QUALITY_MASK_MARKERS = {
  cpf: "[CPF]",
  cnpj: "[CNPJ]",
  phone: "[telefone]",
  email: "[e-mail]",
  bankAccount: "[conta bancária]",
  pixKey: "[chave Pix]",
} as const;

/**
 * A ORDEM DAS REGRAS NÃO É DETALHE. O mais específico vem primeiro: um CNPJ
 * contém uma sequência que um padrão de telefone também casaria, e um e-mail
 * contém texto que o padrão de chave Pix aleatória casaria. Invertida, a
 * ordem produz máscara errada ("[telefone]" no lugar de "[CNPJ]") — o dado
 * continua protegido, mas a IA lê a conversa errada e julga por cima dela.
 */
interface MaskRule {
  name: keyof typeof QUALITY_MASK_MARKERS;
  pattern: RegExp;
  /** Confere o que o padrão pegou; nem todo agrupamento de dígitos é documento. */
  accept?: (match: string) => boolean;
}

/** Só os dígitos, para as conferências de tamanho. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * CPF sem pontuação e celular com DDD têm os MESMOS 11 dígitos, e nenhum
 * formato os separa. Quem desempata é o dígito verificador do CPF: número de
 * telefone só passa nele por coincidência.
 *
 * Errar aqui não expõe dado (as duas regras mascaram), mas troca o marcador, e
 * um "[telefone]" no lugar de "[CPF]" faz a IA ler a conversa errada.
 */
function isCpf(digits: string): boolean {
  if (digits.length !== 11) return false;
  // Sequência repetida ("11111111111") passa na conta e nunca é CPF de verdade.
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const check = (upTo: number): number => {
    let sum = 0;
    for (let index = 0; index < upTo; index += 1) {
      sum += Number(digits[index]) * (upTo + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

const RULES: MaskRule[] = [
  // E-mail primeiro: ele é o único padrão com "@", e deixá-lo para depois faria
  // o trecho antes do "@" ser comido por uma regra de dígitos.
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Chave Pix aleatória: UUID v4 escrito por extenso. Não existe caso legítimo
  // de UUID no texto de uma conversa de WhatsApp — o identificador das
  // mensagens que a IA cita é apelido curto (M1, M2...), nunca o uuid do banco.
  {
    name: "pixKey",
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
  // CNPJ: 14 dígitos, com ou sem pontuação.
  {
    name: "cnpj",
    pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g,
    accept: (match) => digitsOf(match).length === 14,
  },
  // CPF: 11 dígitos com pontuação típica, OU 11 dígitos crus.
  {
    name: "cpf",
    pattern: /\b\d{3}\.\d{3}\.\d{3}-?\d{2}\b/g,
    accept: (match) => digitsOf(match).length === 11,
  },
  // Conta bancária escrita como a equipe escreve: agência e conta com dígito.
  // Vem ANTES do telefone porque "1234-5 / 67890-1" casaria como dois números.
  {
    name: "bankAccount",
    pattern:
      /\b(?:ag(?:[êe]ncia)?\.?\s*:?\s*\d{3,5}(?:-\d)?\s*(?:\/|,|e|\s)\s*)?c(?:onta|\/c|c)\.?\s*:?\s*\d{4,12}-?\d?\b/gi,
  },
  // CPF CRU (11 dígitos seguidos) vem ANTES do telefone, e só passa com o
  // dígito verificador conferindo: sem essa ordem, o padrão de celular com DDD
  // comeria o CPF e o marcador sairia trocado.
  {
    name: "cpf",
    pattern: /\b\d{11}\b/g,
    accept: (match) => isCpf(match),
  },
  // Telefone brasileiro: com DDI, com DDD, com ou sem pontuação. O `\b` inicial
  // impede que ele comece no meio de um número maior, e o `accept` barra "2026"
  // e preço ("1.500,00"): telefone tem de 10 a 13 dígitos.
  {
    name: "phone",
    pattern: /\b(?:\+?55\s*)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g,
    accept: (match) => {
      const digits = digitsOf(match);
      return digits.length >= 10 && digits.length <= 13;
    },
  },
];

/**
 * Substitui por marcador tudo o que este arquivo sabe reconhecer. Devolve
 * também a CONTAGEM por tipo — ela vai para o log (que nunca leva conteúdo) e
 * é o que permite conferir, num teste, que a máscara de fato agiu.
 */
export interface MaskResult {
  text: string;
  counts: Partial<Record<keyof typeof QUALITY_MASK_MARKERS, number>>;
}

export function maskSensitiveData(input: string): MaskResult {
  const counts: MaskResult["counts"] = {};
  let text = input;
  for (const rule of RULES) {
    const marker = QUALITY_MASK_MARKERS[rule.name];
    text = text.replace(rule.pattern, (match) => {
      if (rule.accept && !rule.accept(match)) return match;
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return marker;
    });
  }
  return { text, counts };
}

/** Só o texto, para quem não precisa da contagem. */
export function maskText(input: string | null | undefined): string {
  if (!input) return "";
  return maskSensitiveData(input).text;
}

export function mergeMaskCounts(target: MaskResult["counts"], extra: MaskResult["counts"]): void {
  for (const [key, value] of Object.entries(extra)) {
    const name = key as keyof typeof QUALITY_MASK_MARKERS;
    target[name] = (target[name] ?? 0) + (value ?? 0);
  }
}
