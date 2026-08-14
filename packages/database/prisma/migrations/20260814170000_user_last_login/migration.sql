-- Último login de cada usuário. Fica nulo até o primeiro acesso:
-- não dá para inventar uma data para quem nunca entrou.
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
