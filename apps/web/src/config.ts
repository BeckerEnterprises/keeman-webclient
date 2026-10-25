/** Runtime configuration from /config.json. */
import * as v from "valibot";

export interface RuntimeConfig {
  apiUrl: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const ConfigSchema = v.object({ apiUrl: v.string() });

/** Absolute https URL (http only for localhost), no query, no fragment. */
export function parseConfig(data: unknown): RuntimeConfig {
  const result = v.safeParse(ConfigSchema, data);
  if (!result.success) throw new ConfigError("config.json is invalid");
  let url: URL;
  try {
    url = new URL(result.output.apiUrl);
  } catch {
    throw new ConfigError("apiUrl is not a URL");
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (
    !secure ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    result.output.apiUrl.includes("?") ||
    result.output.apiUrl.includes("#")
  )
    throw new ConfigError("apiUrl is not allowed");
  return { apiUrl: url.href.replace(/\/+$/, "") };
}

export async function loadConfig(): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetch("/config.json", {
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ConfigError("config.json could not be loaded");
  }
  if (!response.ok) throw new ConfigError("config.json could not be loaded");
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ConfigError("config.json is not JSON");
  }
  return parseConfig(data);
}
