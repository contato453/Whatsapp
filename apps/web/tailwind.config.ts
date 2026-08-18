import type { Config } from "tailwindcss";
// A paleta mora no `src/lib/brand.ts` porque nem tudo que é marca vira classe
// do Tailwind: alguns pontos pintam com `style` inline e precisam do hex cru.
// Duas listas de hexes divergiriam no primeiro ajuste de tom.
import { BRAND_COLORS, CHAT_COLORS } from "./src/lib/brand";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: BRAND_COLORS,
        chat: CHAT_COLORS,
      },
    },
  },
  plugins: [],
};

export default config;
