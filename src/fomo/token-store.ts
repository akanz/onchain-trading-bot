import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function tokenExpiry(token: string | undefined): number | null {
  const expiry = Number(token ? jwtPayload(token)?.exp : 0);
  return Number.isFinite(expiry) && expiry > 0 ? expiry : null;
}

export function isUsableFomoToken(
  token: string | undefined,
  now = Date.now() / 1000,
): token is string {
  const payload = token ? jwtPayload(token) : null,
    expiry = Number(payload?.exp);
  return Boolean(
    token && payload?.iss === "privy.io" && Number.isFinite(expiry) && expiry > now + 30,
  );
}

export function readStoredFomoToken(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

export function selectFomoToken(
  envToken: string | undefined,
  path: string,
  rejectedToken?: string,
): string | undefined {
  const stored = readStoredFomoToken(path),
    candidates = [stored, envToken].filter(
      (token) => token !== rejectedToken && isUsableFomoToken(token),
    );
  return candidates.sort((a, b) => (tokenExpiry(b) ?? 0) - (tokenExpiry(a) ?? 0))[0];
}

export function saveFomoToken(path: string, token: string): boolean {
  if (!isUsableFomoToken(token)) return false;
  const current = readStoredFomoToken(path);
  if (current === token) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      token,
      expires_at: tokenExpiry(token),
      captured_at: new Date().toISOString(),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return true;
}
