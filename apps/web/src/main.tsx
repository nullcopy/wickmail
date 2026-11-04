import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./App.js";
import { createBrowserClient } from "./api/client.js";
import "./styles.css";

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <Root client={createBrowserClient()} />
    </StrictMode>,
  );
}
