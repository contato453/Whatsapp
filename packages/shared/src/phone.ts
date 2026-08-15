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
