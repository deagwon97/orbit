import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    allowedHosts: ["orbit-dev-web"],
    proxy: { "/api": { target: loadEnv(mode, ".", "").ORBIT_API_URL || "http://127.0.0.1:3001", ws: true } }
  }
}));
