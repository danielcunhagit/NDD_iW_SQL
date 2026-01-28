import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Configuração explícita do servidor para evitar ambiguidades de rede
  server: {
    port: 1420,
    strictPort: true, // Falha se a porta 1420 estiver ocupada, impedindo o drift para 1421
    host: "127.0.0.1", // Força IPv4, eliminando o problema do ::1 (IPv6)
    watch: {
      // Garante que o HMR funcione mesmo em sistemas de arquivos complexos (opcional)
      usePolling: true,
    },
  },
});