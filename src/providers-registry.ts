import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import {
  API_PROVIDERS,
  mergeProviders,
  providerFileName,
  validateUserProvider,
  type ApiProviderEntry,
  type UserProviderInput,
} from "./api/registry.js";

interface ProviderFile {
  version: 1;
  providers: UserProviderInput[];
}

/**
 * The provider registry: the built-in list plus whatever the user has added.
 *
 * Cached on the file's mtime so the hot paths — resolving an adapter for every
 * task start — do not re-read the file, while `provider add` is still visible
 * immediately without a restart.
 */
export class ProviderRegistry {
  private cache: { path: string; mtimeMs: number; entries: ApiProviderEntry[] } | undefined;

  public constructor(public readonly filePath: string = registryPath ?? join(config.dataDir, providerFileName)) {}

  /** Every known provider, user definitions taking precedence. */
  public entries(): ApiProviderEntry[] {
    const stamp = this.stamp();
    if (this.cache && this.cache.path === this.filePath && this.cache.mtimeMs === stamp) {
      return this.cache.entries;
    }
    const entries = mergeProviders(this.definitions());
    this.cache = { path: this.filePath, mtimeMs: stamp, entries };
    return entries;
  }

  public get(id: string): ApiProviderEntry | undefined {
    return this.entries().find((entry) => entry.id === id);
  }

  public ids(): string[] {
    return this.entries().map((entry) => entry.id);
  }

  /** True when the user defined or overrode this id. */
  public isUserDefined(id: string): boolean {
    return this.definitions().some((entry) => entry.id === id);
  }

  public add(definition: unknown): UserProviderInput {
    const validated = validateUserProvider(definition);
    const existing = this.definitions();
    const without = existing.filter((entry) => entry.id !== validated.id);
    this.write([...without, validated]);
    return validated;
  }

  public remove(id: string): UserProviderInput | undefined {
    const existing = this.definitions();
    const target = existing.find((entry) => entry.id === id);
    if (!target) return undefined;
    this.write(existing.filter((entry) => entry.id !== id));
    return target;
  }

  public definitions(): UserProviderInput[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<ProviderFile>;
      if (!Array.isArray(parsed.providers)) return [];
      const out: UserProviderInput[] = [];
      for (const entry of parsed.providers) {
        try {
          out.push(validateUserProvider(entry));
        } catch {
          // A single bad entry must not hide every other definition.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  private write(providers: UserProviderInput[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload: ProviderFile = { version: 1, providers };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
    this.cache = undefined;
  }

  private stamp(): number {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }
}

/**
 * Where the registry reads from, when it has been pointed somewhere else.
 *
 * The data directory is fixed when config loads, so tests that need their own
 * providers file set this rather than writing into the real one.
 */
let registryPath: string | undefined;

/** Points the registry at another file. Tests use this. */
export const setProviderRegistryPath = (filePath: string | undefined): void => {
  registryPath = filePath;
};

/** The shared instance, pointed at the current data directory. */
export const providerRegistry = (): ProviderRegistry => new ProviderRegistry(registryPath);

export { API_PROVIDERS };