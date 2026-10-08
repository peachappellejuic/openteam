import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

export type SecretSource = "env" | "file" | "missing";

export interface SecretStatus {
  name: string;
  source: SecretSource;
  /** Enough of the value to recognise it, never enough to use it. */
  hint: string;
}

interface StoredFile {
  version: 1;
  keys: Record<string, string>;
}

const FILE_MODE = 0o600;

/**
 * Shows a key is present without disclosing it: a prefix and the last four
 * characters. Short or unprefixed values are reduced to a length only.
 */
export const redact = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `set (${trimmed.length} chars)`;
  const separator = trimmed.search(/[-_]/);
  const prefix = separator > 0 ? trimmed.slice(0, separator + 1) : trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
};

/**
 * Resolves credentials for agent CLIs and direct-API providers.
 *
 * Environment variables win over the stored file so a shell export always beats
 * what was saved earlier, and because that ordering keeps CI and one-off
 * overrides working without editing anything on disk.
 */
export class SecretStore {
  private readonly fileKeys: Record<string, string>;

  private constructor(
    public readonly filePath: string,
    fileKeys: Record<string, string>,
  ) {
    this.fileKeys = fileKeys;
  }

  public static open(filePath: string = defaultSecretsPath()): SecretStore {
    return new SecretStore(filePath, readSecrets(filePath));
  }

  /** Environment first, then the stored file. */
  public get(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const fromEnv = env[name]?.trim();
    if (fromEnv) return fromEnv;
    const stored = this.fileKeys[name]?.trim();
    return stored || undefined;
  }

  /** The first non-empty value among several environment variable names. */
  public getAny(names: string[], env: NodeJS.ProcessEnv = process.env): { name: string; value: string } | undefined {
    for (const name of names) {
      const value = this.get(name, env);
      if (value) return { name, value };
    }
    return undefined;
  }

  public has(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return this.get(name, env) !== undefined;
  }

  public set(name: string, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Refusing to store an empty value for ${name}`);
    writeSecrets(this.filePath, { ...this.fileKeys, [name]: trimmed });
    this.fileKeys[name] = trimmed;
  }

  public unset(name: string): boolean {
    if (!(name in this.fileKeys)) return false;
    const next = { ...this.fileKeys };
    delete next[name];
    writeSecrets(this.filePath, next);
    delete this.fileKeys[name];
    return true;
  }

  public status(name: string, env: NodeJS.ProcessEnv = process.env): SecretStatus {
    const value = this.get(name, env);
    if (!value) return { name, source: "missing", hint: "" };
    return { name, source: env[name]?.trim() ? "env" : "file", hint: redact(value) };
  }

  /**
   * The keys held in the stored file, shaped for a child process environment.
   * Values already present in the real environment are inherited by the child
   * anyway, so only the file's contribution is listed here.
   */
  public environment(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.fileKeys).filter(([, value]) => Boolean(value)));
  }

  public get names(): string[] {
    return Object.keys(this.fileKeys).sort();
  }
}

const defaultSecretsPath = (): string => join(config.dataDir, "keys.json");

const readSecrets = (filePath: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredFile>;
    const keys = parsed.keys;
    if (!keys || typeof keys !== "object") return {};
    return Object.fromEntries(
      Object.entries(keys).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    // A missing or corrupt file is not fatal: env vars still work, and `set` rewrites it.
    return {};
  }
};

const writeSecrets = (filePath: string, keys: Record<string, string>): void => {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const payload: StoredFile = { version: 1, keys };
  writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  // Rename keeps the temporary file's 0600 mode; re-assert it in case it pre-existed.
  chmodSync(temporaryPath, FILE_MODE);
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, FILE_MODE);
};