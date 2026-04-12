import path from "node:path";

import { SessionEventBus } from "./eventBus.js";
import { MockTelegramAdapter } from "./mockAdapter.js";
import { TdlibTelegramAdapter } from "./tdlibAdapter.js";
import type { TelegramAdapter } from "./types.js";

interface AdapterFactoryConfig {
  mode: "mock" | "real";
  apiId?: number;
  apiHash?: string;
  tdlibPath?: string;
  tdlibDataDir: string;
  maxGroupMembers?: number;
  applicationVersion?: string;
  deviceModel?: string;
  systemVersion?: string;
  systemLanguageCode?: string;
}

export function createAdapter(config: AdapterFactoryConfig): {
  adapter: TelegramAdapter;
  bus: SessionEventBus;
} {
  const bus = new SessionEventBus();

  if (config.mode === "real") {
    if (!config.apiId || !config.apiHash) {
      throw new Error("TDLIB_API_ID and TDLIB_API_HASH are required in real mode");
    }

    return {
      bus,
      adapter: new TdlibTelegramAdapter(bus, {
        apiId: config.apiId,
        apiHash: config.apiHash,
        tdlibPath: config.tdlibPath,
        dataDir: path.resolve(config.tdlibDataDir),
        maxGroupMembers: config.maxGroupMembers,
        applicationVersion: config.applicationVersion,
        deviceModel: config.deviceModel,
        systemVersion: config.systemVersion,
        systemLanguageCode: config.systemLanguageCode,
      }),
    };
  }

  return {
    bus,
    adapter: new MockTelegramAdapter(bus),
  };
}
