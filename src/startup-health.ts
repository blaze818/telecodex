import { execFile } from "node:child_process";
import path from "node:path";

import type { TeleCodexConfig } from "./config.js";

interface CodexMcpServerEntry {
  name: string;
  enabled: boolean;
  disabled_reason: string | null;
  transport?: {
    type?: string;
    url?: string;
    bearer_token_env_var?: string | null;
    http_headers?: Record<string, string> | null;
    env_http_headers?: Record<string, string> | null;
  };
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  auth_status?: string | null;
}

const CODEx_MCP_TIMEOUT_MS = 10_000;

export async function verifyStartupHealth(config: TeleCodexConfig): Promise<void> {
  const servers = await loadCodexMcpServers();
  const serverMap = new Map(servers.map((server) => [server.name, server]));

  const problems: string[] = [];

  for (const requiredServer of config.requiredMcpServers) {
    const server = serverMap.get(requiredServer);
    if (!server) {
      problems.push(`Missing Codex MCP server: ${requiredServer}`);
      continue;
    }

    if (!server.enabled) {
      const reason = server.disabled_reason ? ` (${server.disabled_reason})` : "";
      problems.push(`Codex MCP server disabled: ${requiredServer}${reason}`);
      continue;
    }

    if (server.auth_status !== "bearer_token") {
      const authStatus = server.auth_status ?? "unknown";
      problems.push(`Codex MCP server has unsupported auth: ${requiredServer} (${authStatus})`);
      continue;
    }

    if (requiredServer === "graphify") {
      const graphifyStatus = await checkHttpHealth(config.graphifyHealthUrl);
      if (!graphifyStatus.ok) {
        problems.push(`Graphify health check failed: ${graphifyStatus.detail}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Startup health check failed: ${problems.join("; ")}`);
  }
}

function loadCodexMcpServers(): Promise<CodexMcpServerEntry[]> {
  return new Promise((resolve, reject) => {
    const command = buildCodexMcpListCommand(resolveCodexBinary());
    execFile(
      command.file,
      command.args,
      {
        timeout: CODEx_MCP_TIMEOUT_MS,
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = [stderr?.trim(), stdout?.trim(), error.message].filter(Boolean).join("\n");
          reject(new Error(`Failed to query Codex MCP servers: ${message}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!Array.isArray(parsed)) {
            reject(new Error("Codex MCP list did not return an array"));
            return;
          }

          resolve(parsed as CodexMcpServerEntry[]);
        } catch (parseError) {
          const detail = parseError instanceof Error ? parseError.message : String(parseError);
          reject(new Error(`Failed to parse Codex MCP list: ${detail}`));
        }
      },
    );
  });
}

function buildCodexMcpListCommand(codexBinary: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const cmdExe = process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
    return {
      file: cmdExe,
      args: ["/d", "/s", "/c", quoteShellPath(codexBinary), "mcp", "list", "--json"],
    };
  }

  return {
    file: codexBinary,
    args: ["mcp", "list", "--json"],
  };
}

async function checkHttpHealth(url: string): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status} from ${url}` };
    }

    const body = (await response.json()) as { status?: string } | undefined;
    if (body?.status && body.status !== "ok") {
      return { ok: false, detail: `Unexpected status "${body.status}" from ${url}` };
    }

    return { ok: true, detail: "ok" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${url}: ${detail}` };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveCodexBinary(): string {
  if (process.platform === "win32") {
    return path.resolve(process.cwd(), "node_modules", ".bin", "codex.cmd");
  }

  return path.resolve(process.cwd(), "node_modules", ".bin", "codex");
}

function quoteShellPath(commandPath: string): string {
  if (process.platform !== "win32") {
    return commandPath;
  }

  return `"${commandPath.replace(/"/g, '\\"')}"`;
}
