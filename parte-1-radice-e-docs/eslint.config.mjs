import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Livelli (docs/02-architecture.md §2): pagine e componenti non toccano il database. Leggono dal DAL
  // (@/server/dal/*), che applica i permessi e restituisce DTO. Le server action in src/app/actions
  // usano ancora SQL diretto (legacy): migrano ai servizi modulo per modulo.
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/app/actions/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/db", "@/server/db/*"],
              message: "Non importare il database da pagine o componenti: usa una funzione del DAL (@/server/dal/*).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
