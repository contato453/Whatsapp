// Redefine a senha de um usuário (ou cria o admin se não existir).
//
// Uso (produção):
//   docker compose -f docker-compose.prod.yml exec \
//     -e RESET_EMAIL=voce@dominio.com -e RESET_PASSWORD='NovaSenha' \
//     api node packages/database/scripts/reset-password.mjs
//
// Uso (dev local): RESET_EMAIL=... RESET_PASSWORD=... node scripts/reset-password.mjs
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const email = process.env.RESET_EMAIL;
const password = process.env.RESET_PASSWORD;

if (!email || !password) {
  console.error("Defina as variáveis RESET_EMAIL e RESET_PASSWORD.");
  process.exit(1);
}
if (password.length < 6) {
  console.error("A senha deve ter pelo menos 6 caracteres.");
  process.exit(1);
}

const prisma = new PrismaClient();
const passwordHash = await bcrypt.hash(password, 10);

const existing = await prisma.user.findUnique({ where: { email } });
if (existing) {
  await prisma.user.update({
    where: { email },
    data: { passwordHash, status: "active" },
  });
  console.log(`Senha redefinida com sucesso para ${email}`);
} else {
  let org = await prisma.organization.findFirst();
  if (!org) {
    org = await prisma.organization.create({
      data: { name: process.env.RESET_ORG_NAME ?? "Escritório" },
    });
  }
  await prisma.user.create({
    data: {
      organizationId: org.id,
      name: process.env.RESET_NAME ?? "Administrador",
      email,
      passwordHash,
      role: "admin",
    },
  });
  console.log(`Usuário admin criado: ${email}`);
}

await prisma.$disconnect();
