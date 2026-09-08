import { lookup } from "node:dns/promises";
import { load } from "cheerio";
import { extractRawText } from "mammoth";
import { PDFParse } from "pdf-parse";
import { AI_KNOWLEDGE_MAX_CHARS, type AiKnowledgeExtractionResult } from "@azvchat/shared";
import { AppError } from "../../lib/errors.js";

/**
 * Extração de texto para a base de conhecimento a partir de um LINK ou de
 * um DOCUMENTO enviado (PDF/DOCX/TXT).
 *
 * As duas funções aqui NÃO gravam nada — devolvem `{ title, content,
 * truncated }` para a tela preencher o formulário de "Nova fonte", que a
 * equipe revisa e edita antes de mandar para o `POST /ai/knowledge` de
 * sempre. É a mesma ideia da variável de resposta rápida ("a atendente LÊ
 * antes do Enter"): resolver direto e gravar sem revisão transformaria um
 * erro de extração (título errado, trecho de menu de navegação, PDF
 * digitalizado sem texto) em conteúdo publicado sem ninguém perceber. Por
 * isso nenhuma das duas funções tem contrapartida de UPDATE — reextrair é
 * "nova fonte", nunca "atualizar esta".
 */

const URL_FETCH_TIMEOUT_MS = 8_000;
/** HTML é texto: 5 MB já é uma página enorme, sem contar imagem/vídeo embutido. */
const URL_MAX_BYTES = 5 * 1024 * 1024;

function truncate(text: string, max: number): { content: string; truncated: boolean } {
  const trimmed = text.trim().replace(/\n{3,}/g, "\n\n");
  if (trimmed.length <= max) return { content: trimmed, truncated: false };
  return { content: trimmed.slice(0, max), truncated: true };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
}

/** Faixas reservadas/privadas de IPv4 — inclui o endereço de metadados de nuvem (169.254.*). */
const IPV4_RESERVED_RANGES: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["224.0.0.0", "255.255.255.255"],
];

/**
 * O endereço para onde o hostname resolveu é público? Trava contra SSRF:
 * sem isso, "colar um link" vira porta para a API bater na própria rede
 * interna (ou no endpoint de metadados de nuvem) a pedido de qualquer
 * pessoa com a chave `ai.agent.manage`. Endereço que não reconhecemos
 * também é recusado — a régua é "provado público", não "não provado privado".
 */
function isPublicIp(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fe80:")) return false; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return false; // unique local fc00::/7
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.split(":").pop();
      return mapped ? isPublicIp(mapped) : false;
    }
    return true;
  }
  const asInt = ipv4ToInt(ip);
  if (asInt === null) return false;
  return !IPV4_RESERVED_RANGES.some(([start, end]) => {
    const s = ipv4ToInt(start);
    const e = ipv4ToInt(end);
    return s !== null && e !== null && asInt >= s && asInt <= e;
  });
}

async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("Link inválido.", 422, "url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("Só links http:// ou https://.", 422, "url_invalid");
  }
  let address: string;
  try {
    address = (await lookup(url.hostname)).address;
  } catch {
    throw new AppError("Não foi possível resolver esse endereço.", 422, "url_unreachable");
  }
  if (!isPublicIp(address)) {
    throw new AppError("Esse endereço não pode ser acessado.", 422, "url_forbidden");
  }
  return url;
}

/** Lê o corpo da resposta parando (e cancelando) assim que passar do teto de bytes. */
async function readWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AppError("Essa página é grande demais para extrair.", 422, "url_too_large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * Busca um LINK e devolve o texto legível da página. Sem embeddings, sem
 * headless browser: HTML estático é o caso comum de página institucional/
 * FAQ, e é o que a busca lexical da base já sabe aproveitar.
 */
export async function extractUrlText(rawUrl: string): Promise<AiKnowledgeExtractionResult> {
  const url = await assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      // NUNCA segue redirect sozinho: o destino também precisaria passar
      // pela mesma checagem de IP público, e reaplicar a checagem depois do
      // fetch já ter começado é tarde demais para evitar o SSRF.
      redirect: "manual",
      headers: { "user-agent": "AZVCHAT-KnowledgeBot/1.0" },
    });
  } catch {
    clearTimeout(timer);
    throw new AppError("Não foi possível acessar esse link.", 422, "url_unreachable");
  }
  clearTimeout(timer);

  if (response.status >= 300 && response.status < 400) {
    throw new AppError("Esse link redireciona para outro endereço — cole o link de destino direto.", 422, "url_redirect");
  }
  if (!response.ok) {
    throw new AppError(`Essa página respondeu com erro (${response.status}).`, 422, "url_error");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    throw new AppError("Esse link não é uma página de texto (HTML).", 422, "url_unsupported_type");
  }

  const buffer = await readWithLimit(response, URL_MAX_BYTES);
  const raw = buffer.toString("utf8");

  if (contentType.includes("text/plain")) {
    const { content, truncated } = truncate(raw, AI_KNOWLEDGE_MAX_CHARS);
    if (!content) throw new AppError("Essa página está vazia.", 422, "url_empty");
    return { title: url.hostname, content, truncated };
  }

  const $ = load(raw);
  $("script, style, noscript, nav, header, footer, svg, iframe").remove();
  const title = $("title").first().text().trim() || $("h1").first().text().trim() || url.hostname;
  const text = $("body")
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const { content, truncated } = truncate(text, AI_KNOWLEDGE_MAX_CHARS);
  if (!content) throw new AppError("Não encontrei texto nessa página.", 422, "url_empty");
  return { title: title.slice(0, 120), content, truncated };
}

function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, "").trim();
  return withoutExtension || "Documento";
}

/**
 * Extrai texto de um documento enviado. O tipo é decidido pela EXTENSÃO do
 * nome do arquivo (o `mimetype` que o navegador manda para `.docx` costuma
 * vir genérico) — mesmo raciocínio de "quem decide é o conteúdo, não a
 * flag de quem chamou" que já vale para o áudio de saída (seção 8 do
 * CLAUDE.md), só que aqui a checagem é o nome, na falta de assinatura de
 * bytes simples para os três formatos aceitos.
 */
export async function extractDocumentText(buffer: Buffer, filename: string): Promise<AiKnowledgeExtractionResult> {
  const title = titleFromFilename(filename || "documento");
  const extension = (filename || "").toLowerCase().split(".").pop() ?? "";

  if (extension === "txt") {
    const { content, truncated } = truncate(buffer.toString("utf8"), AI_KNOWLEDGE_MAX_CHARS);
    if (!content) throw new AppError("Esse arquivo está vazio.", 422, "document_empty");
    return { title, content, truncated };
  }

  if (extension === "pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const { content, truncated } = truncate(result.text, AI_KNOWLEDGE_MAX_CHARS);
      if (!content) throw new AppError("Não encontrei texto nesse PDF (pode ser digitalizado, sem texto real).", 422, "document_empty");
      return { title, content, truncated };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Não foi possível ler esse PDF.", 422, "document_parse_failed");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  if (extension === "docx") {
    try {
      const result = await extractRawText({ buffer });
      const { content, truncated } = truncate(result.value, AI_KNOWLEDGE_MAX_CHARS);
      if (!content) throw new AppError("Não encontrei texto nesse documento.", 422, "document_empty");
      return { title, content, truncated };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("Não foi possível ler esse documento.", 422, "document_parse_failed");
    }
  }

  throw new AppError("Formato não suportado. Envie PDF, DOCX ou TXT.", 422, "document_unsupported_type");
}
