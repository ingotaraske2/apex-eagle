import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  // VITE_GOOGLE_CLIENT_ID and VITE_SPECIAL_USER_KEY are read at build time
  // Set them in Cloudflare Pages → Settings → Environment Variables
});
