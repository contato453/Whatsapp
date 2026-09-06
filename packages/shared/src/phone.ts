/**
 * Formatação de telefone para exibição.
 *
 * Fica em `shared` porque o backend também precisa dela: quem decide o nome
 * exibido de um participante é o serializer da API, e o telefone formatado é
 * um dos degraus dessa decisão. Sem isso a regra viveria em dois lugares.
 *
 * O que entra aqui é sempre telefone de verdade — identificador "@lid" nunca
 * chega, porque `phoneFromJid` (no pacote whatsapp) devolve null para ele.
 */
export function formatPhone(phone: string | null): string {
  if (!phone) return "";
  // 5511999998888 -> +55 11 99999-8888 (heurística BR simples)
  if (phone.length >= 12 && phone.startsWith("55")) {
    const ddd = phone.slice(2, 4);
    const rest = phone.slice(4);
    const split = rest.length - 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return `+${phone}`;
}

/**
 * Domínios de endereçamento que carregam telefone de verdade. `@lid` fica de
 * fora de propósito: é identificador interno do WhatsApp, não telefone —
 * exibi-lo como se fosse levaria alguém a tentar ligar de volta para um
 * número que não existe.
 */
const REAL_PHONE_JID_DOMAINS = new Set(["s.whatsapp.net", "c.us"]);

/**
 * Telefone a partir de um endereço de chat individual (`"5511999@s.whatsapp.net"`),
 * ou `null` quando o endereço é de grupo, `@lid`, ou não é dígitos puros.
 *
 * Fonte única: a resposta rápida e as variáveis de automação precisam da
 * MESMA régua para decidir se `{{conversa.telefone}}`/`{{telefone}}` tem
 * valor — duas versões da mesma checagem divergiriam no primeiro `@lid` novo
 * que o WhatsApp inventasse.
 */
export function phoneFromChatId(externalChatId: string): string | null {
  const [numero, dominio] = externalChatId.split("@");
  if (!numero || !dominio || !REAL_PHONE_JID_DOMAINS.has(dominio)) return null;
  if (!/^\d{8,15}$/.test(numero)) return null;
  return numero;
}

/** Resultado da normalização de um telefone para envio. */
export type NormalizedPhone =
  | { ok: true; phone: string; jid: string }
  | { ok: false; reason: "empty" | "group" | "length" };

/**
 * Normaliza um telefone brasileiro para o padrão internacional (só dígitos,
 * com o 55 na frente) e monta o JID individual.
 *
 * Fica em `shared` porque a API de integração normaliza ANTES de qualquer
 * coisa (o sistema externo manda "com ou sem pontuação, com ou sem 55") e o
 * teste confere a regra do mesmo lugar. É focada em número BR de propósito:
 * o escritório fala com cliente brasileiro, e prefixar 55 num número
 * estrangeiro seria pior do que recusar.
 *
 * - JID de grupo ("@g.us") é recusado com `group`: esta rota nunca envia para
 *   grupo, e tratar o identificador de grupo como telefone criaria lixo.
 * - O national aceito é DDD(2) + assinante(8 ou 9). Fora disso é `length`.
 * - A mesma heurística de `formatPhone` decide o 55: só tira o prefixo quando
 *   o número tem 12+ dígitos começando com 55; um DDD 55 sem país (10/11
 *   dígitos) recebe o 55 na frente, como deve.
 */
export function normalizeBrazilPhone(raw: string | null | undefined): NormalizedPhone {
  const value = raw ?? "";
  // Identificador de grupo nunca é telefone — barra antes de mexer nos dígitos.
  if (value.includes("@g.us") || value.toLowerCase().includes("g.us")) {
    return { ok: false, reason: "group" };
  }
  const digits = value.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "empty" };

  // País 55 explícito só é removido quando há dígitos suficientes para sobrar
  // um national válido — senão "5511" (curto) perderia o próprio DDD.
  let national = digits;
  if (national.startsWith("55") && national.length >= 12) {
    national = national.slice(2);
  }
  if (national.length !== 10 && national.length !== 11) {
    return { ok: false, reason: "length" };
  }
  const phone = `55${national}`;
  return { ok: true, phone, jid: `${phone}@s.whatsapp.net` };
}
