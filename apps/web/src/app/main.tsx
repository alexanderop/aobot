import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { conversationIdFromUrl } from "./conversation-id.ts";
import "./tokens.css";

const container = document.getElementById("root");

if (container === null) throw new Error("index.html has no #root element");

createRoot(container).render(
  <StrictMode>
    <App conversationId={conversationIdFromUrl(window.location, window.history)} />
  </StrictMode>,
);
