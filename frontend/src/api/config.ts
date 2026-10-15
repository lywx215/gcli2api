import { ApiError, requestJson } from "@/api/client";

export type SafeConfigResponse = {
  config: Record<string, unknown>;
  capabilities: string[];
  env_locked: string[];
  security: Record<string, unknown>;
  secret_fields: Record<"api_password" | "panel_password" | "password", { configured: boolean }>;
};

const SECRET_KEY_NAMES = ["api_password", "panel_password", "password"] as const;

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isStringArray(val: unknown): val is string[] {
  return Array.isArray(val) && val.every((item) => typeof item === "string");
}

export async function readSafeConfig(signal?: AbortSignal): Promise<SafeConfigResponse> {
  const data = await requestJson<unknown>("config/get", {
    method: "GET",
    query: { include_secrets: false },
    signal,
  });

  if (!isObject(data)) {
    throw new ApiError(200, null);
  }

  const { config, capabilities, env_locked, security, secret_fields } = data;

  if (!isObject(config)) {
    throw new ApiError(200, null);
  }

  for (const key of SECRET_KEY_NAMES) {
    if (Object.prototype.hasOwnProperty.call(config, key) || key in config) {
      throw new ApiError(200, null);
    }
  }

  if (!isStringArray(capabilities)) {
    throw new ApiError(200, null);
  }

  if (!isStringArray(env_locked)) {
    throw new ApiError(200, null);
  }

  if (!isObject(security)) {
    throw new ApiError(200, null);
  }

  if (!isObject(secret_fields)) {
    throw new ApiError(200, null);
  }

  for (const key of SECRET_KEY_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(secret_fields, key)) {
      throw new ApiError(200, null);
    }
    const item = secret_fields[key];
    if (
      !isObject(item) ||
      !Object.prototype.hasOwnProperty.call(item, "configured") ||
      typeof item.configured !== "boolean"
    ) {
      throw new ApiError(200, null);
    }
  }

  return {
    config: config as Record<string, unknown>,
    capabilities: [...capabilities],
    env_locked: [...env_locked],
    security: security as Record<string, unknown>,
    secret_fields: {
      api_password: { configured: (secret_fields.api_password as { configured: boolean }).configured },
      panel_password: { configured: (secret_fields.panel_password as { configured: boolean }).configured },
      password: { configured: (secret_fields.password as { configured: boolean }).configured },
    },
  };
}
