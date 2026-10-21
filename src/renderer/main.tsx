import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

async function boot() {
  // In Electron the preload installs window.river. In a plain browser we fall
  // back to an in-memory node so the interface can be reviewed. Never in production.
  if (!("river" in window)) {
    await import("./mock");
  }

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
