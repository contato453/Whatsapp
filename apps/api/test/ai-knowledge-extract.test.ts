import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_KNOWLEDGE_MAX_CHARS } from "@azvchat/shared";
import { AppError } from "../src/lib/errors.js";
import { extractDocumentText, extractUrlText } from "../src/services/ai/knowledge-extract.js";

/**
 * Extração de LINK e DOCUMENTO para a base de conhecimento
 * (`services/ai/knowledge-extract.ts`). O que precisa ficar trancado:
 *
 * 1. link privado/reservado (loopback, rede interna, metadados de nuvem)
 *    é RECUSADO antes de qualquer `fetch` — é a trava de SSRF;
 * 2. só http/https, sem seguir redirect sozinho;
 * 3. só página de texto (html/plain) — o resto é recusado pelo Content-Type;
 * 4. texto extraído acima do teto é CORTADO, nunca rejeitado, com
 *    `truncated: true`;
 * 5. documento decide o formato pela EXTENSÃO do nome, não pelo mimetype;
 * 6. PDF/DOCX sem texto nenhum (ex.: digitalizado) vira erro claro, não
 *    fonte vazia.
 *
 * `pdf-parse` e `mammoth` são mockados: o que se testa aqui é a COLA (
 * roteamento por extensão, corte pelo teto, mensagens de erro), não as
 * bibliotecas de terceiro.
 */

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));

const pdfGetTextMock = vi.fn();
const pdfDestroyMock = vi.fn().mockResolvedValue(undefined);
vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(() => ({ getText: pdfGetTextMock, destroy: pdfDestroyMock })),
}));

const mammothExtractMock = vi.fn();
vi.mock("mammoth", () => ({ extractRawText: (...args: unknown[]) => mammothExtractMock(...args) }));

function htmlResponse(html: string, contentType = "text/html; charset=utf-8", status = 200): Response {
  return new Response(html, { status, headers: { "content-type": contentType } });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue({ address: "93.184.216.34", family: 4 });
  pdfGetTextMock.mockReset();
  pdfDestroyMock.mockClear();
  mammothExtractMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractUrlText", () => {
  it("extrai título e texto, removendo script/style/nav", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse(`
          <html>
            <head><title>Serviços do Escritório</title><style>.x{color:red}</style></head>
            <body>
              <nav>Menu: Início | Contato</nav>
              <script>console.log("x")</script>
              <h1>Abertura de empresa</h1>
              <p>Cuidamos do registro na Junta e do CNPJ.</p>
            </body>
          </html>
        `),
      ),
    );

    const result = await extractUrlText("https://www.exemplo.com.br/servicos");

    expect(result.title).toBe("Serviços do Escritório");
    expect(result.content).toContain("Abertura de empresa");
    expect(result.content).toContain("Cuidamos do registro na Junta e do CNPJ.");
    expect(result.content).not.toContain("Menu: Início");
    expect(result.content).not.toContain("console.log");
    expect(result.truncated).toBe(false);
  });

  it("recusa endereço privado ANTES de tentar buscar (trava de SSRF)", async () => {
    lookupMock.mockResolvedValue({ address: "127.0.0.1", family: 4 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(extractUrlText("http://localhost/admin")).rejects.toMatchObject({
      code: "url_forbidden",
    } satisfies Partial<AppError>);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recusa o endereço de metadados de nuvem (169.254.169.254)", async () => {
    lookupMock.mockResolvedValue({ address: "169.254.169.254", family: 4 });
    vi.stubGlobal("fetch", vi.fn());

    await expect(extractUrlText("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({
      code: "url_forbidden",
    });
  });

  it("recusa esquema que não é http/https, sem sequer resolver o DNS", async () => {
    await expect(extractUrlText("ftp://arquivos.exemplo.com/a.txt")).rejects.toMatchObject({
      code: "url_invalid",
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("não segue redirect sozinho", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://outro.exemplo/" } })));

    await expect(extractUrlText("https://exemplo.com/vai-redirecionar")).rejects.toMatchObject({
      code: "url_redirect",
    });
  });

  it("recusa conteúdo que não é texto (html/plain)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("binário", { status: 200, headers: { "content-type": "application/octet-stream" } })));

    await expect(extractUrlText("https://exemplo.com/arquivo.bin")).rejects.toMatchObject({
      code: "url_unsupported_type",
    });
  });

  it("texto acima do teto é CORTADO, nunca rejeitado", async () => {
    const long = "parágrafo bem grande. ".repeat(10_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(`<html><body><p>${long}</p></body></html>`)));

    const result = await extractUrlText("https://exemplo.com/artigo-longo");

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(AI_KNOWLEDGE_MAX_CHARS);
  });
});

describe("extractDocumentText", () => {
  it(".txt é lido direto, sem biblioteca nenhuma", async () => {
    const result = await extractDocumentText(Buffer.from("Horário: 8h às 18h.", "utf8"), "horario.txt");
    expect(result.title).toBe("horario");
    expect(result.content).toBe("Horário: 8h às 18h.");
    expect(result.truncated).toBe(false);
  });

  it(".pdf delega ao pdf-parse e libera o parser no final", async () => {
    pdfGetTextMock.mockResolvedValue({ text: "Conteúdo extraído do PDF." });

    const result = await extractDocumentText(Buffer.from("qualquer coisa"), "Contrato Social.pdf");

    expect(result.title).toBe("Contrato Social");
    expect(result.content).toBe("Conteúdo extraído do PDF.");
    expect(pdfDestroyMock).toHaveBeenCalledTimes(1);
  });

  it(".docx delega ao mammoth", async () => {
    mammothExtractMock.mockResolvedValue({ value: "Texto do Word.", messages: [] });

    const result = await extractDocumentText(Buffer.from("qualquer coisa"), "manual.docx");

    expect(result.content).toBe("Texto do Word.");
    expect(mammothExtractMock).toHaveBeenCalledWith({ buffer: expect.any(Buffer) });
  });

  it("PDF sem texto (digitalizado) vira erro, não fonte vazia", async () => {
    pdfGetTextMock.mockResolvedValue({ text: "   " });

    await expect(extractDocumentText(Buffer.from("x"), "digitalizado.pdf")).rejects.toMatchObject({
      code: "document_empty",
    });
  });

  it("formato não suportado é recusado, e nenhuma biblioteca é chamada", async () => {
    await expect(extractDocumentText(Buffer.from("MZ..."), "programa.exe")).rejects.toMatchObject({
      code: "document_unsupported_type",
    });
    expect(pdfGetTextMock).not.toHaveBeenCalled();
    expect(mammothExtractMock).not.toHaveBeenCalled();
  });

  it("erro do parser vira mensagem em português, não a exceção crua", async () => {
    pdfGetTextMock.mockRejectedValue(new Error("bad xref table"));

    await expect(extractDocumentText(Buffer.from("x"), "corrompido.pdf")).rejects.toMatchObject({
      code: "document_parse_failed",
    });
  });
});
