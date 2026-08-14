// Carrega variáveis do .env (raiz do monorepo e apps/api) para process.env
// ANTES de qualquer validação de config. Variáveis já definidas no ambiente
// têm precedência — em Docker/produção este arquivo é um no-op.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, "../../../../.env"), // raiz do monorepo
  path.resolve(here, "../../.env"), // apps/api/.env (override local)
];

for (const envPath of candidates) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1] as string] === undefined) {
      process.env[match[1] as string] = value;
    }
  }
}
