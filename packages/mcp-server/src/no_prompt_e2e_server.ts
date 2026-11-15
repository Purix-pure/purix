// src/no_prompt_e2e_server.ts
// Entry point for no_prompt_e2e.test.ts: the real stdio server, started the way `purix mcp-serve` starts it. Not a test file.
import { runMcpServer } from "./server";

await runMcpServer();
