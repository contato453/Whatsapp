import type { AiKnowledgeKind } from "@azvchat/shared";

/**
 * Base de conhecimento: recuperação LEXICAL por trechos.
 *
 * Não há embeddings nem pgvector nesta entrega, de propósito: a base de um
 * escritório são dezenas de parágrafos e algumas perguntas frequentes, e
 * um ranking por sobreposição de termos (com acentos e plurais normalizados)
 * já escolhe bem os trechos — sem chamada extra ao provedor, sem custo, sem
 * infraestrutura nova. A função é a única porta (`retrieveKnowledge`), então
 * trocar por busca semântica no futuro é trocar a implementação aqui.
 *
 * O que NUNCA acontece: mandar a base inteira ao modelo. Só os trechos mais
 * relevantes para a pergunta, com teto de tamanho.
 */

export interface KnowledgeSourceInput {
  id: string;
  title: string;
  kind: AiKnowledgeKind;
  content: string;
}

export interface KnowledgeChunk {
  sourceId: string;
  sourceTitle: string;
  text: string;
}

export interface KnowledgeHit extends KnowledgeChunk {
  score: number;
}

const CHUNK_MAX_CHARS = 700;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_CHARS = 3500;

/** Palavras que não distinguem nada em português. */
const STOPWORDS = new Set([
  "a", "o", "e", "de", "da", "do", "das", "dos", "em", "um", "uma", "para", "por", "com", "que",
  "se", "na", "no", "nas", "nos", "ao", "aos", "as", "os", "é", "eu", "me", "meu", "minha", "voce",
  "você", "vc", "ele", "ela", "isso", "esse", "essa", "este", "esta", "como", "qual", "quais", "quanto",
  "quando", "onde", "tem", "ter", "ser", "sao", "são", "foi", "sobre", "mais", "ja", "já", "nao", "não",
  "sim", "ola", "olá", "bom", "boa", "dia", "tarde", "noite", "obrigado", "obrigada", "por", "favor",
  "gostaria", "queria", "saber", "pode", "posso", "preciso", "quero", "ou", "mas", "também", "tambem",
]);

export function normalizeTerm(word: string): string {
  const base = word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
  // Plural e algumas flexões simples: "empresas" → "empresa", "abertura" fica.
  if (base.length > 4 && base.endsWith("s")) return base.slice(0, -1);
  return base;
}

export function tokenize(text: string): string[] {
  return text
    .split(/[\s,.;:!?()[\]{}"'\-/\\]+/)
    .map(normalizeTerm)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
}

/** Quebra uma fonte em trechos. FAQ vira um trecho por pergunta+resposta. */
export function chunkSource(source: KnowledgeSourceInput): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  const push = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) chunks.push({ sourceId: source.id, sourceTitle: source.title, text: trimmed });
  };

  if (source.kind === "faq") {
    // Formato: linhas "P: pergunta" e "R: resposta", em pares; blocos
    // separados por linha em branco. Tolerante a "Pergunta:"/"Resposta:".
    const blocks = source.content.split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) continue;
      push(lines.join("\n"));
    }
    return chunks;
  }

  const paragraphs = source.content.split(/\n\s*\n/);
  let current = "";
  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (piece.length > CHUNK_MAX_CHARS) {
      if (current) {
        push(current);
        current = "";
      }
      // Parágrafo longo: corta por frase até o teto.
      let buffer = "";
      for (const sentence of piece.split(/(?<=[.!?])\s+/)) {
        if ((buffer + " " + sentence).length > CHUNK_MAX_CHARS && buffer) {
          push(buffer);
          buffer = sentence;
        } else {
          buffer = buffer ? `${buffer} ${sentence}` : sentence;
        }
      }
      if (buffer) push(buffer);
      continue;
    }
    if ((current + "\n\n" + piece).length > CHUNK_MAX_CHARS && current) {
      push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) push(current);
  return chunks;
}

/**
 * Ranking: termos da pergunta presentes no trecho, com peso maior para
 * termo que aparece no título da fonte e para trecho curto (mais denso).
 * Sem nenhum termo em comum o trecho não entra — melhor sem contexto do
 * que com contexto errado, que o modelo tende a usar.
 */
export function retrieveKnowledge(
  sources: KnowledgeSourceInput[],
  query: string,
  options: { topK?: number; maxChars?: number } = {},
): KnowledgeHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  const topK = options.topK ?? DEFAULT_TOP_K;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const hits: KnowledgeHit[] = [];
  for (const source of sources) {
    const titleTerms = new Set(tokenize(source.title));
    for (const chunk of chunkSource(source)) {
      const chunkTerms = tokenize(chunk.text);
      if (chunkTerms.length === 0) continue;
      const counts = new Map<string, number>();
      for (const term of chunkTerms) counts.set(term, (counts.get(term) ?? 0) + 1);
      let score = 0;
      let matched = 0;
      for (const term of terms) {
        const count = counts.get(term) ?? 0;
        if (count > 0) {
          matched += 1;
          // Frequência saturada: o segundo "cnpj" vale menos que o primeiro.
          score += 1 + Math.log(count);
        }
        if (titleTerms.has(term)) score += 0.5;
      }
      if (matched === 0) continue;
      // Cobertura da pergunta pesa mais que tamanho do trecho.
      score = score * (matched / terms.length) * (1 + 50 / (chunkTerms.length + 50));
      hits.push({ ...chunk, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);

  const selected: KnowledgeHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (selected.length >= topK) break;
    if (used + hit.text.length > maxChars) continue;
    selected.push(hit);
    used += hit.text.length;
  }
  return selected;
}
