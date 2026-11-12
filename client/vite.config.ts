import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Keep the browser's Host (localhost:5174): sign-in redirects and the CSRF origin check use it.
      // (The string shorthand would rewrite it to localhost:4100.)
      "/api": { target: "http://localhost:4100", changeOrigin: false },
    },
  },
});
