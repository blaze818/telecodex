import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { verifyStartupHealth } from "../src/startup-health.js";
import type { TeleCodexConfig } from "../src/config.js";

const baseConfig: TeleCodexConfig = {
  telegramBotToken: "bot-token",
  telegramAllowedUserIds: [123],
  telegramAllowedUserIdSet: new Set([123]),
  workspace: "C:\\Users\\Daniel",
  maxFileSize: 20 * 1024 * 1024,
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "never",
  launchProfiles: [],
  defaultLaunchProfileId: "default",
  enableUnsafeLaunchProfiles: false,
  toolVerbosity: "summary",
  showTurnTokenUsage: false,
  enableTelegramLogin: true,
  enableTelegramReactions: false,
  requiredMcpServers: ["graphify", "home_assistant"],
  graphifyHealthUrl: "http://localhost:4000/health",
};

function mockCodexMcpList(servers: unknown): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, JSON.stringify(servers), "");
  });
}

describe("startup-health", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes when required servers are enabled and graphify is healthy", async () => {
    mockCodexMcpList([
      { name: "graphify", enabled: true, disabled_reason: null, auth_status: "bearer_token" },
      { name: "home_assistant", enabled: true, disabled_reason: null, auth_status: "bearer_token" },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyStartupHealth(baseConfig)).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(String(mockExecFile.mock.calls[0]?.[0]).toLowerCase()).toContain("\\system32\\cmd.exe");
    expect(mockExecFile.mock.calls[0]?.[2]).not.toMatchObject({ shell: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails when a required MCP server is missing", async () => {
    mockCodexMcpList([
      { name: "home_assistant", enabled: true, disabled_reason: null, auth_status: "bearer_token" },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyStartupHealth(baseConfig)).rejects.toThrow(
      "Missing Codex MCP server: graphify",
    );
  });

  it("fails when graphify health check fails", async () => {
    mockCodexMcpList([
      { name: "graphify", enabled: true, disabled_reason: null, auth_status: "bearer_token" },
      { name: "home_assistant", enabled: true, disabled_reason: null, auth_status: "bearer_token" },
    ]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ status: "down" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyStartupHealth(baseConfig)).rejects.toThrow("Graphify health check failed");
  });
});
