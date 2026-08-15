import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

/**
 * Seed inicial: cria a organização padrão e um usuário admin.
 * Credenciais controladas por env (com defaults apenas para desenvolvimento).
 */
async function main(): Promise<void> {
  const orgName = process.env.SEED_ORG_NAME ?? "Escritório";
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "admin123";
  const adminName = process.env.SEED_ADMIN_NAME ?? "Administrador";

  let org = await prisma.organization.findFirst({ where: { name: orgName } });
  if (!org) {
    org = await prisma.organization.create({ data: { name: orgName } });
    console.log(`Organização criada: ${org.name} (${org.id})`);
  }

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        organizationId: org.id,
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: "admin",
      },
    });
    console.log(`Usuário admin criado: ${adminEmail}`);
    if (!process.env.SEED_ADMIN_PASSWORD) {
      console.log("ATENÇÃO: usando senha padrão de desenvolvimento (admin123). Troque em produção.");
    }
  } else {
    console.log(`Usuário admin já existe: ${adminEmail}`);
  }

  const defaultDepartments = ["Atendimento", "Contábil", "Fiscal", "Departamento Pessoal"];
  for (const name of defaultDepartments) {
    await prisma.department.upsert({
      where: { organizationId_name: { organizationId: org.id, name } },
      update: {},
      create: { organizationId: org.id, name },
    });
  }
  console.log("Departamentos padrão garantidos.");

  // Parâmetros de atendimento da organização. A migration semeia as
  // organizações que já existiam; aqui garantimos a linha da organização que
  // o próprio seed acabou de criar, para a tela de Parâmetros abrir com o
  // padrão da casa em vez do fallback de `@azvchat/shared`.
  const settings = await prisma.attendanceSettings.upsert({
    where: { organizationId: org.id },
    update: {},
    create: { organizationId: org.id },
  });
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await prisma.attendanceBusinessHours.upsert({
      where: { settingsId_weekday: { settingsId: settings.id, weekday } },
      update: {},
      create: {
        settingsId: settings.id,
        weekday,
        // Segunda a sexta ativos; sábado e domingo desligados.
        active: weekday >= 1 && weekday <= 5,
      },
    });
  }
  // Janela de login da mesma organização. Fica gravada mesmo com a restrição
  // desligada, para a tela abrir com faixa razoável em vez de campo vazio no
  // dia em que a supervisão resolver ligar.
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await prisma.attendanceLoginHours.upsert({
      where: { settingsId_weekday: { settingsId: settings.id, weekday } },
      update: {},
      create: {
        settingsId: settings.id,
        weekday,
        active: weekday >= 1 && weekday <= 5,
      },
    });
  }
  console.log("Parâmetros de atendimento garantidos (30 min, seg-sex 08:00-18:00).");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
