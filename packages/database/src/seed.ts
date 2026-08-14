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
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
