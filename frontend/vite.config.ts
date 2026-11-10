// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import type { ConfigEnv } from "vite";

export default (environment: ConfigEnv) =>
  defineConfig({
    // The container build is a static SPA served by Fastify. Development keeps
    // Lovable's existing TanStack/Nitro behavior.
    ...(environment.command === "build" ? { nitro: false } : {}),
    tanstackStart: {
      ...(environment.command === "build" ? { spa: { enabled: true } } : {}),
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      server: { entry: "server" },
    },
  })(environment);
