import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Mesmo atalho "@/..." do tsconfig do Next, para o teste importar o
    // módulo pelo caminho que o código usa.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
