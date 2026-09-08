-- Base de conhecimento passa a aceitar link (URL) e documento (PDF/DOCX/TXT)
-- como origem do conteúdo, além de texto livre e FAQ — ver
-- apps/api/src/services/ai/knowledge-extract.ts. Extração é só um jeito a
-- mais de PREENCHER o campo `content` (a equipe revisa/edita antes de
-- salvar, exatamente como já fazia colando texto à mão): nenhum arquivo
-- binário nem cópia da página fica guardado, só o texto extraído — mesma
-- filosofia de "é texto, não anexo" que já valia para os dois tipos antigos.
ALTER TYPE "AiKnowledgeKind" ADD VALUE 'url';
ALTER TYPE "AiKnowledgeKind" ADD VALUE 'document';

-- De onde veio o texto, só para exibição na lista (o link ou o nome do
-- arquivo) — nunca usado para buscar de novo nem para decidir nada. Nulo
-- para text/faq, que a equipe digitou direto.
ALTER TABLE "ai_knowledge_sources" ADD COLUMN "sourceRef" TEXT;
