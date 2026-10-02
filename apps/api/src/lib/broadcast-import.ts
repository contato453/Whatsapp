import ExcelJS from "exceljs";
import {
  BROADCAST_LIMITS,
  guessImportRole,
  normalizeBrazilPhone,
  normalizeColumnKey,
  type BroadcastImportPreviewDto,
} from "@azvchat/shared";
import { AppError } from "./errors.js";

/**
 * LEITURA DA PLANILHA — e só isso. Nada aqui grava contato.
 *
 * A importação é de DOIS PASSOS de propósito: primeiro a prévia devolve as
 * colunas que existem no arquivo, o palpite de qual é nome/telefone/empresa e
 * as primeiras linhas; depois a pessoa confirma o mapeamento e manda importar.
 *
 * Um passo só seria mais curto e erraria calado: planilha de escritório tem
 * "Telefone 1"/"Celular"/"Contato" em colunas diferentes a cada arquivo, e
 * adivinhar sozinho significa importar 800 contatos com o telefone da coluna
 * errada — o que só se descobre quando o disparo sai para os números errados,
 * e aí não se desfaz. Mesmo espírito da variável da resposta rápida
 * ("a atendente LÊ antes do Enter") e da extração da base de conhecimento da
 * IA ("a equipe revisa antes de gravar").
 */

/** Uma linha da planilha, já como texto e chaveada pelo nome ORIGINAL da coluna. */
export type SpreadsheetRow = Record<string, string>;

export interface SpreadsheetData {
  columns: string[];
  rows: SpreadsheetRow[];
}

/** O papel de cada coluna, decidido por quem importa. */
export interface ImportMapping {
  phone: string;
  name?: string | null;
  company?: string | null;
  /** Colunas que viram `{{campo.<chave>}}`; vazio = nenhuma. */
  extras?: string[];
}

/** Valor de célula do ExcelJS vira texto — ele devolve objeto em vários casos. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    // Data vira DD/MM/AAAA: a planilha do escritório usa data como texto de
    // mensagem ("vence em {{campo.vencimento}}"), e o ISO com fuso seria lido
    // pelo cliente como lixo.
    return value.toLocaleDateString("pt-BR", { timeZone: "UTC" });
  }
  if (typeof value === "object") {
    const objeto = value as Record<string, unknown>;
    // Célula com fórmula: o que interessa é o RESULTADO, nunca a fórmula.
    if ("result" in objeto) return cellText(objeto.result);
    if ("text" in objeto) return cellText(objeto.text);
    // Texto rico: o ExcelJS quebra em pedaços com formatação.
    if (Array.isArray(objeto.richText)) {
      return (objeto.richText as { text?: unknown }[]).map((parte) => cellText(parte.text)).join("");
    }
    if ("hyperlink" in objeto) return cellText(objeto.text ?? objeto.hyperlink);
  }
  return String(value).trim();
}

/**
 * CSV com aspas, ponto e vírgula e vírgula.
 *
 * Parser próprio, e não uma biblioteca: o caso é uma planilha exportada, o
 * formato tem três regras (aspas, aspas escapadas e separador) e uma
 * dependência a mais só para isso não se paga. O separador é DETECTADO na
 * primeira linha porque o Excel em português exporta com ponto e vírgula, e
 * assumir vírgula transformaria a planilha inteira numa coluna só.
 */
function parseCsv(text: string): string[][] {
  const conteudo = text.replace(/^\uFEFF/, "");
  const primeiraLinha = conteudo.split(/\r?\n/, 1)[0] ?? "";
  const separador = (primeiraLinha.match(/;/g)?.length ?? 0) > (primeiraLinha.match(/,/g)?.length ?? 0)
    ? ";"
    : ",";

  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let dentroDeAspas = false;

  for (let i = 0; i < conteudo.length; i += 1) {
    const caractere = conteudo[i];
    if (dentroDeAspas) {
      if (caractere === '"') {
        if (conteudo[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += caractere;
      }
      continue;
    }
    if (caractere === '"') {
      dentroDeAspas = true;
    } else if (caractere === separador) {
      linha.push(campo.trim());
      campo = "";
    } else if (caractere === "\n") {
      linha.push(campo.trim());
      linhas.push(linha);
      linha = [];
      campo = "";
    } else if (caractere !== "\r") {
      campo += caractere;
    }
  }
  if (campo.length > 0 || linha.length > 0) {
    linha.push(campo.trim());
    linhas.push(linha);
  }
  return linhas.filter((item) => item.some((valor) => valor.length > 0));
}

/** Cabeçalho sem nome vira "Coluna N" — planilha com coluna vazia é comum. */
function nomearColunas(cabecalho: string[]): string[] {
  const usados = new Set<string>();
  return cabecalho.map((bruto, indice) => {
    let nome = bruto.trim() || `Coluna ${indice + 1}`;
    // Duas colunas com o MESMO cabeçalho quebrariam o mapa de linha (a
    // segunda sobrescreveria a primeira em silêncio) — desempata visível.
    let sufixo = 2;
    while (usados.has(nome)) {
      nome = `${bruto.trim() || `Coluna ${indice + 1}`} (${sufixo})`;
      sufixo += 1;
    }
    usados.add(nome);
    return nome;
  });
}

/**
 * Lê a planilha inteira (xlsx, xls ou csv) e devolve cabeçalho + linhas.
 *
 * O formato é decidido pela EXTENSÃO do nome, não pelo mimetype — o
 * navegador manda tipo genérico para `.xlsx` com frequência (a mesma
 * armadilha documentada na extração de documento da base de conhecimento).
 */
export async function readSpreadsheet(
  buffer: Buffer,
  fileName: string,
): Promise<SpreadsheetData> {
  const extensao = fileName.toLowerCase().split(".").pop() ?? "";

  let matriz: string[][];
  if (extensao === "csv" || extensao === "txt") {
    matriz = parseCsv(buffer.toString("utf8"));
  } else if (extensao === "xlsx" || extensao === "xlsm" || extensao === "xls") {
    const workbook = new ExcelJS.Workbook();
    try {
      // O ExcelJS tipa `load` com ArrayBuffer; o Buffer do Node é aceito em
      // runtime e o cast fica confinado a esta linha.
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new AppError(
        "Não consegui abrir a planilha. Salve como .xlsx ou .csv e tente de novo.",
        422,
        "planilha_ilegivel",
      );
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new AppError("A planilha está vazia.", 422, "planilha_vazia");
    }
    matriz = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const valores = Array.isArray(row.values) ? row.values.slice(1) : [];
      matriz.push(valores.map((valor) => cellText(valor)));
    });
  } else {
    throw new AppError(
      "Formato não suportado. Envie .xlsx, .xls ou .csv.",
      422,
      "formato_nao_suportado",
    );
  }

  const [cabecalho, ...corpo] = matriz;
  if (!cabecalho || cabecalho.length === 0) {
    throw new AppError("A planilha não tem cabeçalho na primeira linha.", 422, "sem_cabecalho");
  }

  const columns = nomearColunas(cabecalho);
  const rows: SpreadsheetRow[] = [];
  for (const linha of corpo) {
    if (rows.length >= BROADCAST_LIMITS.MAX_IMPORT_ROWS) break;
    const registro: SpreadsheetRow = {};
    columns.forEach((coluna, indice) => {
      registro[coluna] = (linha[indice] ?? "").trim();
    });
    // Linha totalmente vazia (rodapé, separador) não vira contato.
    if (Object.values(registro).some((valor) => valor.length > 0)) rows.push(registro);
  }

  return { columns, rows };
}

/** A prévia que a tela mostra antes de qualquer gravação. */
export function buildImportPreview(data: SpreadsheetData): BroadcastImportPreviewDto {
  const suggested: Record<string, "name" | "phone" | "company" | null> = {};
  for (const coluna of data.columns) suggested[coluna] = guessImportRole(coluna);
  return {
    columns: data.columns,
    suggested,
    sample: data.rows.slice(0, 5),
    totalRows: data.rows.length,
  };
}

export interface PreparedContact {
  phone: string;
  name: string | null;
  company: string | null;
  fields: Record<string, string>;
}

export interface PrepareResult {
  contacts: PreparedContact[];
  /** Linhas recusadas, com o número da linha da planilha (cabeçalho = 1). */
  rejected: { row: number; phone: string; reason: string }[];
  /** Repetidas DENTRO do próprio arquivo. */
  duplicatedInFile: number;
}

/**
 * Converte as linhas no que vai para o banco, aplicando o mapeamento.
 *
 * Três coisas acontecem aqui, e todas antes de encostar no banco:
 *   1. o telefone é NORMALIZADO (é o que faz a deduplicação funcionar);
 *   2. linha sem telefone válido é recusada COM O NÚMERO DA LINHA, para a
 *      pessoa corrigir a planilha em vez de adivinhar;
 *   3. repetido dentro do próprio arquivo é contado e descartado — planilha
 *      de escritório costuma ter o mesmo cliente em duas linhas.
 */
export function prepareContacts(
  data: SpreadsheetData,
  mapping: ImportMapping,
): PrepareResult {
  const contacts: PreparedContact[] = [];
  const rejected: PrepareResult["rejected"] = [];
  const vistos = new Set<string>();
  let duplicatedInFile = 0;

  const extras = mapping.extras ?? [];

  data.rows.forEach((linha, indice) => {
    const numeroDaLinha = indice + 2; // +1 do cabeçalho, +1 porque planilha começa em 1
    const bruto = linha[mapping.phone] ?? "";
    const normalizado = normalizeBrazilPhone(bruto);
    if (!normalizado.ok) {
      if (rejected.length < 20) {
        rejected.push({
          row: numeroDaLinha,
          phone: bruto,
          reason:
            normalizado.reason === "empty"
              ? "Sem telefone"
              : normalizado.reason === "group"
                ? "É um grupo, não um telefone"
                : "Telefone com quantidade de dígitos inválida",
        });
      }
      return;
    }
    if (vistos.has(normalizado.phone)) {
      duplicatedInFile += 1;
      return;
    }
    vistos.add(normalizado.phone);

    const fields: Record<string, string> = {};
    for (const coluna of extras) {
      const valor = linha[coluna];
      if (valor) fields[normalizeColumnKey(coluna)] = valor;
    }

    contacts.push({
      phone: normalizado.phone,
      name: (mapping.name ? linha[mapping.name] : "")?.trim() || null,
      company: (mapping.company ? linha[mapping.company] : "")?.trim() || null,
      fields,
    });
  });

  return { contacts, rejected, duplicatedInFile };
}
