-- Marcação de papel da pessoa dentro do cliente: sócio ou contato
-- administrativo. É atributo de PARTICIPANTE, por isso não usa `tags` nem
-- `conversation_tags` — aquelas são etiquetas da conversa.
--
-- Coluna anulável e sem default: "nenhuma marcação" é o estado natural da
-- imensa maioria dos participantes, e seleção única é garantida por ser uma
-- coluna só (nunca sócio e administrativo ao mesmo tempo).
--
-- Não confundir com `isAdmin`, que é administrador do grupo no WhatsApp e
-- continua vindo do sync.

-- CreateEnum
CREATE TYPE "ParticipantClientRole" AS ENUM ('partner', 'administrative');

-- AlterTable
ALTER TABLE "group_participants" ADD COLUMN     "clientRole" "ParticipantClientRole";
