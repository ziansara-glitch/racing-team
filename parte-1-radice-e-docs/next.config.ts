import type { NextConfig } from "next";

// Header di sicurezza su ogni risposta. Il CSP è volutamente limitato alle direttive che non toccano gli
// script inline di Next (niente `script-src`): vieta di incorniciare l'app, di cambiare <base> e di inviare
// moduli altrove. Un CSP completo con nonce è un lavoro a parte (docs/06-deployment.md, «Limiti»).
// Fa eccezione /api/media, che imposta già il proprio CSP restrittivo per i file caricati.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Il microfono serve alle note vocali della chat; il resto non è usato.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=15552000" }]
    : []),
];
const pageCsp = { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" };

// cacheComponents è spento: l'app è interamente legata alla sessione dell'utente.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Dietro il tunnel temporaneo le risposte gzip si bloccano: si avvia con NEXT_COMPRESS=false.
  compress: process.env.NEXT_COMPRESS !== "false",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/((?!api/media).*)", headers: [pageCsp] },
    ];
  },
  // Percorsi storici (prima dell'introduzione di Admin e App): i vecchi segnalibri continuano a funzionare.
  async redirects() {
    return [
      { source: "/member", destination: "/app", permanent: false },
      { source: "/member/meetings", destination: "/app/meetings", permanent: false },
      { source: "/member/team", destination: "/app/team", permanent: false },
      { source: "/account", destination: "/app/profile", permanent: false },
      { source: "/admin/meetings", destination: "/admin/calendar", permanent: false },
    ];
  },
};

export default nextConfig;
