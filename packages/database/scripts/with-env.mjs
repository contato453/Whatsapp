// Carrega o .env da raiz do monorepo (e o local, se existir) antes de
// executar o comando passado como argumento. Variáveis já definidas no
// ambiente têm precedência — em Docker/produção nada muda.
//
// Uso: node scripts/with-env.mjs prisma migrate deploy
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, "../../../.env"), // raiz do monorepo
  path.resolve(here, "../.env"), // packages/database/.env (override local)
];

for (const envPath of candidates) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = value;
    }
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Uso: node scripts/with-env.mjs <comando> [args...]");
  process.exit(1);
}
const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
