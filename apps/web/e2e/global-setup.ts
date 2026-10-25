/**
 * Starts a fresh keeman-server for the run: own config (0600), data
 * directory (0700) and secret from the environment, relaxed rate limits,
 * dev_mode for the cookie on http://localhost. Test data only.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WEB_URL } from "./env";

/**
 * The server under test: KEEMAN_SERVER_BIN names a built binary,
 * KEEMAN_SERVER_DIR a checkout of the server repository that is built here.
 * Relative paths count from where pnpm was started, not from apps/web.
 */
function serverBinary(): string {
  const base = process.env.INIT_CWD ?? process.cwd();
  const configured = process.env.KEEMAN_SERVER_BIN;
  if (configured) return resolve(base, configured);
  const checkout = process.env.KEEMAN_SERVER_DIR;
  if (!checkout)
    throw new Error(
      "The end-to-end tests need a KeeMan server: set KEEMAN_SERVER_BIN to a " +
        "keeman-server binary or KEEMAN_SERVER_DIR to a checkout of the server " +
        "repository.",
    );
  const serverRepo = resolve(base, checkout);
  // Always build: cargo is quick when nothing changed, and a stale binary
  // would test an old API.
  const build = spawnSync("cargo", ["build", "--release", "--locked"], {
    cwd: serverRepo,
    stdio: "inherit",
  });
  const binary = join(serverRepo, "target/release/keeman-server");
  // Without cargo on PATH the existing binary is used.
  const missingCargo = build.error !== undefined && existsSync(binary);
  if (!missingCargo && (build.status !== 0 || !existsSync(binary)))
    throw new Error("building keeman-server failed");
  return binary;
}

function configToml(dataDir: string): string {
  return `[server]
listen = "127.0.0.1:18787"
public_api_url = "http://localhost:18787"
allowed_origins = ["${WEB_URL}"]

[storage]
data_dir = "${dataDir}"

[security]
registration = "invite"
dev_mode = true

[webauthn]
rp_id = "localhost"
rp_origins = ["${WEB_URL}"]

[rate_limits]
prelogin_per_ip_per_min = 100000
credential_per_ip_per_min = 100000
credential_per_email_per_min = 100000
register_per_ip_per_hour = 100000
refresh_per_ip_per_min = 100000
events_per_ip_per_min = 100000
session_per_min = 100000

[logging]
level = "warn"
format = "text"
`;
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:18787/v1/health");
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("keeman-server did not become healthy");
}

export default async function globalSetup(): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "keeman-e2e-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const config = join(dir, "config.toml");
  writeFileSync(config, configToml(dataDir), { mode: 0o600 });
  const secret = randomBytes(32).toString("base64url");
  const binary = serverBinary();
  const server = spawn(binary, ["serve", "--config", config], {
    env: { PATH: process.env.PATH, KEEMAN_SERVER_SECRET: secret },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForHealth();
  process.env.KEEMAN_E2E_BIN = binary;
  process.env.KEEMAN_E2E_CONFIG = config;
  process.env.KEEMAN_E2E_SECRET = secret;
  return () => {
    server.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };
}
