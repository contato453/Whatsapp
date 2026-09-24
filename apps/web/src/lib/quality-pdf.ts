import type { jsPDF } from "jspdf";
import {
  QUALITY_CONFIDENCE_LABELS,
  QUALITY_OUTCOME_LABELS,
  QUALITY_SUBJECT_LABELS,
  criterionLabel,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatScore,
  itemReasonText,
  itemStatusLabel,
  runStatusLabel,
  scoreTone,
} from "@/components/quality/quality-ui";
import type { QualityEvaluationDto, QualityRunDetailDto, QualityRunItemDto } from "@/lib/types";
import { BRAND_COLORS, BRAND_NAVY } from "@/lib/brand";

/**
 * O RELATÓRIO DE QUALIDADE EM PDF — um documento A4 de verdade, para BAIXAR.
 *
 * O primeiro desenho era a tela impressa: o botão abria a caixa de impressão do
 * navegador e o CSS escondia o resto da página. Funcionava, mas o que saía era
 * uma página web espremida em papel — largura de tela, cartões cortados no fim
 * da folha, e um passo a mais (escolher "Salvar como PDF") entre o clique e o
 * arquivo. Quem baixa este relatório vai anexá-lo num e-mail ou guardá-lo numa
 * pasta, e para isso ele precisa ser um documento: margem, cabeçalho, rodapé
 * com número de página e quebras que não partem um critério ao meio.
 *
 * O PDF É GERADO NO NAVEGADOR, em vetor, e nunca no servidor. Renderizar no
 * servidor exigiria um navegador headless dentro da imagem da API (centenas de
 * megabytes numa VPS pequena, subindo a cada deploy) para produzir o que a
 * própria aba já consegue produzir. Aqui o custo é uma dependência de
 * frontend, carregada **sob demanda**: o `import("jspdf")` mora dentro da
 * função de download, então a tela de Quality (e todas as outras) não paga
 * nada por ele até alguém clicar em Baixar PDF.
 *
 * É VETOR, e não uma foto da tela. Nada de html2canvas: rasterizar produziria
 * texto borrado, arquivo grande e conteúdo que não dá para copiar nem pesquisar
 * — justamente o contrário do que se espera de um relatório que vai para o
 * e-mail de alguém. O custo aceito é que este layout é ESCRITO aqui, e não
 * herdado do componente: um documento tem cabeçalho, rodapé e paginação que a
 * tela não tem, e as duas coisas nunca seriam a mesma. Quem mexer no conteúdo
 * da avaliação precisa lembrar dos dois lugares — e é por isso que os RÓTULOS
 * saem todos de `quality-ui.ts`/`@azvchat/shared`, os mesmos da tela: o que não
 * pode divergir (nome de critério, assunto, desfecho, formato de nota) tem
 * fonte única, e só a disposição é local.
 *
 * AS TRANSCRIÇÕES FICAM DE FORA, como ficavam na impressão: são o conteúdo
 * bruto da conversa, e num relatório de dez conversas virariam dezenas de
 * páginas do que o administrador já lê no chat.
 */

/** A4 retrato, em milímetros. */
const LARGURA = 210;
const ALTURA = 297;
const MARGEM = 16;
/** O rodapé ocupa a faixa de baixo: o conteúdo para antes dela. */
const LIMITE_INFERIOR = ALTURA - 20;
const CONTEUDO = LARGURA - MARGEM * 2;

/** pt → mm, para a altura de linha sair na mesma unidade do resto. */
const PT = 0.352_777_78;

const CINZA_TEXTO = "#334155";
const CINZA_FRACO = "#64748b";
const CINZA_LINHA = "#e2e8f0";
const CINZA_FUNDO = "#f8fafc";

/** As mesmas três faixas de nota da tela (`scoreTone`), em hex para o papel. */
const TOM_DA_NOTA: Record<"green" | "amber" | "red", { fundo: string; texto: string }> = {
  green: { fundo: "#ecfdf5", texto: "#047857" },
  amber: { fundo: "#fffbeb", texto: "#b45309" },
  red: { fundo: "#fef2f2", texto: "#b91c1c" },
};

/**
 * O QUE O PAPEL CONSEGUE ESCREVER — e por que isto não é frescura.
 *
 * As fontes padrão do PDF (Helvetica aqui) escrevem WinAnsi, que cobre o
 * português inteiro: á, ã, ç, é, ê, ó, ú passam sem nada especial. O que NÃO
 * passa é o que o WhatsApp deixa a equipe pôr em nome de grupo: setas (o
 * escritório usa "Deck ⇄ Contabilidade") e emoji. Nesses casos o jsPDF troca a
 * string inteira por uma codificação de dois bytes que a fonte não tem, e o
 * título sai como "D e c k !Ä C o n t a b i l i d a d e" — ilegível, no lugar
 * mais visível do documento.
 *
 * Embutir uma fonte Unicode resolveria, ao custo de algumas centenas de
 * kilobytes no pacote do navegador para desenhar uma seta. Então o que sai do
 * alcance vira equivalente em ASCII, e o que não tem equivalente (emoji) é
 * REMOVIDO em vez de virar caixinha: o nome do cliente continua legível, que é
 * o que o documento precisa.
 */
const SUBSTITUICOES: Array<[RegExp, string]> = [
  [/[\u21c4\u21c6\u2194\u27f7\u21d4]/g, "-"], // setas de mão dupla: "Deck ⇄ Contabilidade"
  [/[\u2192\u21d2\u27f6\u25b8\u279c]/g, ">"], // setas para a direita
  [/[\u2190\u21d0\u27f5]/g, "<"],
  [/[\u2018\u2019\u201b]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/[\u2022\u25cf\u00b7]/g, "\u00b7"],
  [/\u2026/g, "..."],
  [/[\u2013\u2014]/g, "-"],
  [/\u00a0/g, " "],
];

export function paraPapel(texto: string): string {
  let saida = texto;
  for (const [de, para] of SUBSTITUICOES) saida = saida.replace(de, para);
  // Sobrou fora do WinAnsi (emoji, ideograma) → fora. Espaço duplo que isso
  // deixar é colapsado, senão o nome fica com buracos no meio.
  return saida
    .replace(/[^\u0020-\u007e\u00a0-\u00ff\u20ac\u2020\u2021\u2030]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Nome do arquivo salvo: legível, sem acento e sem barra (barra no meio do nome
 * vira diretório e o salvamento falha). Mesma higienização do download de
 * áudio, e pelo mesmo motivo — o arquivo vai parar na pasta de alguém.
 */
export function qualityPdfFileName(run: QualityRunDetailDto, agora = new Date()): string {
  const alvo =
    run.conversationTitles.length === 1
      ? run.conversationTitles[0]
      : run.conversationTitles.length > 1
        ? `${run.conversationTitles.length}-conversas`
        : null;
  return `qualidade-${nomeSeguro(alvo, "analise")}-${carimbo(agora)}.pdf`;
}

function nomeSeguro(valor: string | null | undefined, padrao: string): string {
  const limpo = (valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60)
    .replace(/-+$/g, "");
  return limpo || padrao;
}

function carimbo(date: Date): string {
  const p = (valor: number) => String(valor).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * A folha: cursor vertical, quebra de página e os desenhos que o relatório usa.
 *
 * A REGRA QUE EVITA O DEFEITO CLÁSSICO daqui é `reservar`: antes de escrever um
 * bloco, pergunta-se se ele CABE. Sem isso o título de um critério fica no pé de
 * uma página e a justificativa dele começa na seguinte, que é o jeito mais
 * rápido de um relatório parecer quebrado.
 */
class Folha {
  y = MARGEM;

  constructor(readonly doc: jsPDF) {}

  novaPagina(): void {
    this.doc.addPage();
    this.y = MARGEM;
  }

  /** Garante `altura` mm livres; quebra a página quando não houver. */
  reservar(altura: number): void {
    if (this.y + altura > LIMITE_INFERIOR) this.novaPagina();
  }

  /** Altura de uma linha para o tamanho de fonte dado. */
  linha(tamanho: number, entrelinha = 1.35): number {
    return tamanho * PT * entrelinha;
  }

  /**
   * Escreve texto que quebra sozinho na largura disponível, paginando linha a
   * linha: parágrafo longo atravessa a virada de página em vez de ser empurrado
   * inteiro para a próxima, que deixaria meia folha em branco.
   */
  paragrafo(
    texto: string,
    opcoes: { tamanho?: number; cor?: string; estilo?: "normal" | "bold"; x?: number; largura?: number } = {},
  ): void {
    const tamanho = opcoes.tamanho ?? 9;
    const x = opcoes.x ?? MARGEM;
    const largura = opcoes.largura ?? CONTEUDO - (x - MARGEM);
    this.doc.setFont("helvetica", opcoes.estilo ?? "normal");
    this.doc.setFontSize(tamanho);
    this.doc.setTextColor(opcoes.cor ?? CINZA_TEXTO);
    const altura = this.linha(tamanho);
    // O saneamento mora AQUI, e não em cada chamada: um ponto só garante que o
    // texto novo de amanhã não escape dele.
    for (const linha of this.doc.splitTextToSize(paraPapel(texto), largura) as string[]) {
      this.reservar(altura);
      this.y += altura;
      this.doc.text(linha, x, this.y - altura * 0.25);
    }
  }

  /** Quantos mm um texto ocuparia, sem escrevê-lo: usado por `reservar`. */
  medir(texto: string, tamanho: number, largura = CONTEUDO): number {
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(tamanho);
    return (this.doc.splitTextToSize(paraPapel(texto), largura) as string[]).length * this.linha(tamanho);
  }

  espaco(mm: number): void {
    this.y += mm;
  }

  regua(): void {
    this.reservar(2);
    this.doc.setDrawColor(CINZA_LINHA);
    this.doc.setLineWidth(0.2);
    this.doc.line(MARGEM, this.y, LARGURA - MARGEM, this.y);
    this.espaco(2);
  }
}

/** A pílula da nota, igual em espírito à da tela: fundo claro e número escuro. */
function pilulaDeNota(folha: Folha, score: number, x: number, y: number, largura = 16, altura = 9): void {
  const tom = TOM_DA_NOTA[scoreTone(score)];
  folha.doc.setFillColor(tom.fundo);
  folha.doc.roundedRect(x, y, largura, altura, 1.5, 1.5, "F");
  folha.doc.setFont("helvetica", "bold");
  folha.doc.setFontSize(12);
  folha.doc.setTextColor(tom.texto);
  folha.doc.text(formatScore(score), x + largura / 2, y + altura / 2 + 1.6, { align: "center" });
}

/** Cabeçalho do documento, só na primeira página. */
function capa(folha: Folha, run: QualityRunDetailDto): void {
  const { doc } = folha;
  // Faixa da marca no topo: é o que faz o papel parecer do AZVCHAT sem
  // depender de uma imagem embutida.
  doc.setFillColor(BRAND_COLORS[600]);
  doc.rect(0, 0, LARGURA, 4, "F");
  folha.y = MARGEM + 4;

  folha.paragrafo("Relatório de qualidade do atendimento", {
    tamanho: 17,
    estilo: "bold",
    cor: BRAND_NAVY,
  });
  folha.espaco(1);

  const alvo =
    run.conversationTitles.length > 0
      ? run.conversationTitles.join(" · ")
      : `${run.conversationCount} ${run.conversationCount === 1 ? "conversa" : "conversas"}`;
  folha.paragrafo(alvo, { tamanho: 11, cor: CINZA_TEXTO });
  folha.espaco(1);
  folha.paragrafo(
    `Período avaliado de ${formatDate(run.periodFrom)} a ${formatDate(run.periodTo)}`,
    { tamanho: 10, estilo: "bold", cor: CINZA_TEXTO },
  );
  folha.espaco(2);
  folha.regua();
  folha.paragrafo(
    `Análise ${runStatusLabel(run.status).toLowerCase()} · disparada por ${run.requestedByName} em ${formatDateTime(run.createdAt)} · modelo ${run.model}`,
    { tamanho: 8, cor: CINZA_FRACO },
  );
  folha.espaco(4);
}

/** O bloco de uma conversa dentro do disparo. */
function secaoDaConversa(folha: Folha, item: QualityRunItemDto): void {
  const titulo = item.conversationTitle ?? "Conversa sem título";
  // O NOME DA CONVERSA NUNCA FICA SOZINHO NO PÉ DA PÁGINA. Reservar só a altura
  // do próprio título deixava "Allan - Faz Bem" na última linha de uma folha e
  // a avaliação inteira na seguinte, e quem lê procura de quem é aquela nota na
  // página errada. Tendo avaliação embaixo, o título só entra se o começo dela
  // couber junto (os mesmos 50mm de cabeçalho + métricas).
  folha.reservar(item.evaluations.length > 0 ? 65 : 15);
  folha.espaco(2);
  folha.paragrafo(titulo, { tamanho: 12, estilo: "bold", cor: BRAND_NAVY });

  const detalhes = [
    itemStatusLabel(item.status),
    item.coveragePercent != null ? `cobertura ${item.coveragePercent}%` : null,
    item.audioCount > 0 ? `${item.audioTranscribedCount} de ${item.audioCount} áudios transcritos` : null,
    item.truncated ? "conversa recortada" : null,
  ].filter((parte): parte is string => Boolean(parte));
  folha.paragrafo(detalhes.join(" · "), { tamanho: 8, cor: CINZA_FRACO });

  const motivo = itemReasonText(item);
  if (motivo) {
    folha.espaco(1);
    folha.paragrafo(motivo, { tamanho: 8.5, cor: CINZA_FRACO });
  }
  folha.espaco(2);
}

/** As seis métricas objetivas, em duas fileiras de três. */
function metricas(folha: Folha, evaluation: QualityEvaluationDto): void {
  const { metrics } = evaluation;
  const celulas: Array<[string, string]> = [
    ["Primeira resposta", formatMinutes(metrics.firstResponseMinutes)],
    ["Tempo médio", formatMinutes(metrics.avgResponseMinutes)],
    ["Limite estourado", `${metrics.limitBreaches}x`],
    ["Mensagens enviadas", String(metrics.messagesSent)],
    ["Mensagens recebidas", String(metrics.messagesReceived)],
    ["Desfecho", QUALITY_OUTCOME_LABELS[metrics.outcome]],
  ];

  const colunas = 3;
  const vao = 3;
  const largura = (CONTEUDO - vao * (colunas - 1)) / colunas;
  const alturaCelula = 13;
  const linhas = Math.ceil(celulas.length / colunas);
  // As duas fileiras andam juntas: separá-las numa virada de página deixaria
  // três números órfãos no pé da folha.
  folha.reservar(linhas * (alturaCelula + vao));

  celulas.forEach(([rotulo, valor], indice) => {
    const coluna = indice % colunas;
    const fileira = Math.floor(indice / colunas);
    const x = MARGEM + coluna * (largura + vao);
    const y = folha.y + fileira * (alturaCelula + vao);
    folha.doc.setFillColor(CINZA_FUNDO);
    folha.doc.roundedRect(x, y, largura, alturaCelula, 1.5, 1.5, "F");
    folha.doc.setFont("helvetica", "normal");
    folha.doc.setFontSize(7.5);
    folha.doc.setTextColor(CINZA_FRACO);
    folha.doc.text(paraPapel(rotulo), x + 3, y + 5);
    folha.doc.setFont("helvetica", "bold");
    folha.doc.setFontSize(10);
    folha.doc.setTextColor(CINZA_TEXTO);
    folha.doc.text(
      folha.doc.splitTextToSize(paraPapel(valor), largura - 6)[0] as string,
      x + 3,
      y + 10.2,
    );
  });
  folha.y += linhas * (alturaCelula + vao);
}

/** Uma lista com marcador, usada pelo plano de ação e pelos pontos fortes. */
function lista(
  folha: Folha,
  titulo: string,
  cor: string,
  itens: Array<{ principal: string; secundario?: string }>,
  vazio: string,
): void {
  folha.reservar(folha.linha(9.5) + 6);
  folha.espaco(1.5);
  folha.paragrafo(titulo, { tamanho: 9.5, estilo: "bold", cor });
  if (itens.length === 0) {
    folha.paragrafo(vazio, { tamanho: 8.5, cor: CINZA_FRACO, x: MARGEM + 4 });
    return;
  }
  for (const item of itens) {
    // O marcador acompanha a PRIMEIRA linha do item, e o texto recua para as
    // demais não nascerem embaixo dele.
    folha.reservar(folha.linha(8.5));
    const topo = folha.y;
    folha.paragrafo(item.principal, { tamanho: 8.5, estilo: "bold", x: MARGEM + 5 });
    folha.doc.setFillColor(cor);
    folha.doc.circle(MARGEM + 2, topo + folha.linha(8.5) * 0.55, 0.7, "F");
    if (item.secundario) {
      folha.paragrafo(item.secundario, { tamanho: 8.5, cor: CINZA_FRACO, x: MARGEM + 5 });
    }
    folha.espaco(1);
  }
}

/** A avaliação de um atendente. */
function avaliacao(folha: Folha, evaluation: QualityEvaluationDto): void {
  // O CABEÇALHO E AS MÉTRICAS ANDAM JUNTOS. Reservar só o cabeçalho deixava
  // "Tatiana Ribeiro 5,5" no pé de uma página e as seis células no topo da
  // seguinte — a nota de uma pessoa separada dos números dela é o corte mais
  // confuso que este documento pode ter. 18mm do cabeçalho + 32mm das duas
  // fileiras de métrica.
  folha.reservar(50);
  folha.espaco(2);
  const topo = folha.y;
  pilulaDeNota(folha, evaluation.overallScore, LARGURA - MARGEM - 16, topo);

  const selos = [
    QUALITY_SUBJECT_LABELS[evaluation.subject],
    `confiança ${QUALITY_CONFIDENCE_LABELS[evaluation.confidence].toLowerCase()}`,
    evaluation.partial ? `PARCIAL (cobertura ${evaluation.coveragePercent}%)` : null,
    evaluation.discardedAt ? "DESCARTADA" : null,
  ].filter((parte): parte is string => Boolean(parte));

  folha.paragrafo(evaluation.userName, {
    tamanho: 11.5,
    estilo: "bold",
    cor: BRAND_NAVY,
    largura: CONTEUDO - 20,
  });
  folha.paragrafo(selos.join(" · "), { tamanho: 8, cor: CINZA_FRACO, largura: CONTEUDO - 20 });
  folha.espaco(2);

  metricas(folha, evaluation);
  folha.espaco(2);

  folha.reservar(folha.linha(9.5) + 6);
  folha.paragrafo("Notas por critério", { tamanho: 9.5, estilo: "bold", cor: CINZA_TEXTO });
  folha.espaco(1);

  for (const criterion of evaluation.criteria) {
    // O critério inteiro (nome, nota e primeira linha da justificativa) entra
    // junto ou vai para a próxima página: nome sem justificativa embaixo é o
    // pior corte possível aqui.
    const alturaJustificativa = folha.medir(criterion.justification, 8.5, CONTEUDO - 24);
    folha.reservar(Math.min(alturaJustificativa, folha.linha(8.5) * 2) + 8);
    const linhaTopo = folha.y;
    folha.paragrafo(criterionLabel(criterion.key), {
      tamanho: 9,
      estilo: "bold",
      largura: CONTEUDO - 24,
    });
    pilulaDeNota(folha, criterion.score, LARGURA - MARGEM - 13, linhaTopo + 0.5, 13, 6.5);
    folha.paragrafo(criterion.justification, { tamanho: 8.5, cor: CINZA_FRACO, largura: CONTEUDO - 24 });
    folha.espaco(2.5);
  }

  lista(
    folha,
    "Plano de ação",
    "#b45309",
    evaluation.actionPlan.improvements.map((improvement) => ({
      principal: improvement.point,
      secundario: improvement.action,
    })),
    "Nenhum ponto a melhorar apontado.",
  );

  lista(
    folha,
    "Pontos fortes",
    "#047857",
    evaluation.actionPlan.strengths.map((strength) => ({ principal: strength })),
    "Nenhum ponto forte registrado.",
  );

  // O comentário do administrador é a única linha humana num documento que o
  // resto é da IA, e por isso entra sempre que existir.
  if (evaluation.adminComment) {
    folha.reservar(folha.linha(9.5) + 8);
    folha.espaco(1.5);
    folha.paragrafo("Comentário do administrador", { tamanho: 9.5, estilo: "bold", cor: CINZA_TEXTO });
    folha.paragrafo(evaluation.adminComment, { tamanho: 8.5 });
  }

  folha.espaco(3);
  folha.regua();
}

/**
 * Rodapé em TODAS as páginas, escrito no fim: o total de páginas só existe
 * depois de o conteúdo inteiro ter sido desenhado.
 */
function rodape(doc: jsPDF, run: QualityRunDetailDto): void {
  const total = doc.getNumberOfPages();
  for (let pagina = 1; pagina <= total; pagina += 1) {
    doc.setPage(pagina);
    doc.setDrawColor(CINZA_LINHA);
    doc.setLineWidth(0.2);
    doc.line(MARGEM, ALTURA - 14, LARGURA - MARGEM, ALTURA - 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(CINZA_FRACO);
    doc.text(
      `AZVCHAT · Relatório de qualidade · período de ${formatDate(run.periodFrom)} a ${formatDate(run.periodTo)}`,
      MARGEM,
      ALTURA - 9.5,
    );
    doc.text(`Página ${pagina} de ${total}`, LARGURA - MARGEM, ALTURA - 9.5, { align: "right" });
    // Documento interno: quem receber o arquivo por e-mail precisa saber que
    // ele carrega avaliação de pessoa, e não um relatório para o cliente.
    doc.setFontSize(6.5);
    doc.text("Documento interno. Contém avaliação de desempenho.", MARGEM, ALTURA - 6);
  }
}

/**
 * Monta o documento e o devolve, sem salvar. Separado do download para o teste
 * conseguir montar o PDF e conferir paginação e formato sem um navegador.
 *
 * O `import` dinâmico é o que mantém a biblioteca fora do carregamento da
 * tela: ela só desce quando alguém clica em baixar.
 */
export async function buildQualityRunPdf(run: QualityRunDetailDto): Promise<jsPDF> {
  const { jsPDF: JsPDF } = await import("jspdf");
  const doc = new JsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
  doc.setProperties({
    title: `Relatório de qualidade · ${run.conversationTitles.join(", ") || run.id}`,
    subject: `Período de ${formatDate(run.periodFrom)} a ${formatDate(run.periodTo)}`,
    creator: "AZVCHAT",
  });

  const folha = new Folha(doc);
  capa(folha, run);

  const comAvaliacao = run.items.filter((item) => item.evaluations.length > 0);
  for (const item of run.items) {
    secaoDaConversa(folha, item);
    for (const evaluation of item.evaluations) avaliacao(folha, evaluation);
  }
  if (comAvaliacao.length === 0) {
    folha.paragrafo(
      "Nenhuma conversa deste disparo gerou avaliação. Os motivos estão indicados acima, em cada conversa.",
      { tamanho: 9, cor: CINZA_FRACO },
    );
  }

  rodape(doc, run);
  return doc;
}

/** Monta e SALVA: é o que o botão "Baixar PDF" chama. */
export async function downloadQualityRunPdf(run: QualityRunDetailDto): Promise<void> {
  const doc = await buildQualityRunPdf(run);
  doc.save(qualityPdfFileName(run));
}
