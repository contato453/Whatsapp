import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * Oculta as bolhas que NUNCA foram mensagem.
 *
 * Antes de a edição ser reconhecida, o pacote de protocolo que o WhatsApp
 * manda quando o cliente edita uma mensagem caía no classificador de
 * conteúdo e virava uma linha de tipo "other", sem texto e sem arquivo — a
 * bolha "Mídia indisponível" que a equipe vê no histórico.
 *
 * O que este script faz e o que ele NÃO faz:
 * - nada de exclusão física: a linha continua no banco, com `deletedAt` e a
 *   marca `protocolArtifact` no `metadata` (a marca é o que faz a tela
 *   simplesmente não desenhar a linha, em vez de anunciar "Esta mensagem foi
 *   apagada" e sugerir que o cliente apagou algo);
 * - nada de reassociação retroativa: a linha lixo foi gravada com o
 *   identificador do PACOTE de edição, e o identificador da mensagem
 *   original vinha dentro do pacote, que não foi guardado. Não há como saber
 *   com certeza a qual mensagem cada uma se referia, e aplicar edição por
 *   palpite escreveria no histórico do cliente errado;
 * - nada de mexer em linha com conteúdo, com mídia ou já apagada.
 *
 * Uso (padrão é só CONTAR e mostrar amostra):
 *   pnpm --filter @azvchat/database exec tsx src/limpar-bolhas-de-protocolo.ts
 *   pnpm --filter @azvchat/database exec tsx src/limpar-bolhas-de-protocolo.ts --aplicar
 */

const APLICAR = process.argv.includes("--aplicar");
const AMOSTRA = 5;

/**
 * O recorte seguro: tipo desconhecido, sem texto, sem arquivo e ainda não
 * apagada. É o que a tela mostra como bolha vazia, e nada mais — mensagem
 * legítima que perdeu só o arquivo continua tendo `mediaUrl` gravado e fica
 * de fora.
 */
const RECORTE = {
  type: "other",
  content: null,
  mediaUrl: null,
  deletedAt: null,
} as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const total = await prisma.message.count({ where: RECORTE });
    const amostra = await prisma.message.findMany({
      where: RECORTE,
      orderBy: { timestamp: "desc" },
      take: AMOSTRA,
      select: {
        id: true,
        conversationId: true,
        externalMessageId: true,
        direction: true,
        type: true,
        content: true,
        mediaUrl: true,
        timestamp: true,
        createdAt: true,
      },
    });

    console.log(`Bolhas sem conteúdo algum encontradas: ${total}`);
    console.log(`Amostra (até ${AMOSTRA}):`);
    console.table(amostra);

    if (!APLICAR) {
      console.log("\nModo conferência. Nada foi alterado.");
      console.log("Para ocultar (soft delete, reversível), rode de novo com --aplicar.");
      return;
    }

    // Uma a uma porque o `metadata` de cada linha precisa ser preservado —
    // updateMany não sabe mesclar JSON.
    let ocultadas = 0;
    const agora = new Date();
    for (;;) {
      const lote = await prisma.message.findMany({
        where: RECORTE,
        take: 500,
        select: { id: true, metadata: true },
      });
      if (lote.length === 0) break;
      for (const linha of lote) {
        const base =
          linha.metadata && typeof linha.metadata === "object" && !Array.isArray(linha.metadata)
            ? { ...(linha.metadata as Record<string, unknown>) }
            : {};
        base.protocolArtifact = true;
        await prisma.message.update({
          where: { id: linha.id },
          // Sem `deletedByUserId`: não foi pessoa nenhuma, foi correção do
          // sistema — a mesma convenção do arquivamento automático.
          data: { deletedAt: agora, metadata: base as Prisma.InputJsonValue },
        });
        ocultadas += 1;
      }
    }
    console.log(`\nOcultadas: ${ocultadas}. Para desfazer, basta limpar deleted_at nessas linhas.`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
