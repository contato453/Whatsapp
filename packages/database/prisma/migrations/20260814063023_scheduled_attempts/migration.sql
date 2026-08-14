-- AlterTable
ALTER TABLE "scheduled_messages" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;
