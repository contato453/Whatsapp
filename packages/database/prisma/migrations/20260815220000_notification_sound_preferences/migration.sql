-- Preferência pessoal de som de notificação, no mesmo lugar de `signMessages`:
-- é escolha do atendente, não parâmetro da organização.
--
-- Dois enums em vez de texto livre porque a API valida contra eles e o
-- frontend monta o seletor a partir da mesma lista — valor fora do conjunto
-- não entra nem pelo banco.
--
-- NOT NULL com DEFAULT preenche as linhas existentes na própria alteração:
-- quem já usa o sistema passa a ouvir o som 1 em volume médio, sem precisar
-- abrir Configurações. "Nenhum" é escolha explícita, nunca o estado inicial.

-- CreateEnum
CREATE TYPE "NotificationSound" AS ENUM ('none', 'sound_1', 'sound_2', 'sound_3');

-- CreateEnum
CREATE TYPE "NotificationVolume" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notificationSound" "NotificationSound" NOT NULL DEFAULT 'sound_1';
ALTER TABLE "users" ADD COLUMN     "notificationVolume" "NotificationVolume" NOT NULL DEFAULT 'medium';
