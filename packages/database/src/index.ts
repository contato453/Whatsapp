import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

let prismaSingleton: PrismaClient | null = null;

/**
 * Retorna um PrismaClient singleton para o processo.
 * A API deve sempre usar esta função em vez de instanciar diretamente.
 */
export function getPrisma(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["warn", "error"]
          : ["error"],
    });
  }
  return prismaSingleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (prismaSingleton) {
    await prismaSingleton.$disconnect();
    prismaSingleton = null;
  }
}
