import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // StrictMode removido para evitar dupla execução da lógica de inicialização no Tauri
  <App />
);