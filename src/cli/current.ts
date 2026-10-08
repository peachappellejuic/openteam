import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface CurrentFile {
  version: 1;
  project?: string;
}

/**
 * The pinned project: which repository openteam should act on when there is no
 * git repository in the working directory. This is what makes the CLI usable
 * from anywhere without naming a project every time.
 */
export class ProjectPointer {
  private current: CurrentFile;

  public constructor(public readonly filePath: string) {
    this.current = this.load();
  }

  public get pinned(): string | undefined {
    return this.current.project;
  }

  public pin(projectId: string): void {
    this.write({ version: 1, project: projectId });
  }

  public clear(): void {
    this.write({ version: 1 });
  }

  private load(): CurrentFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CurrentFile>;
      return typeof parsed.project === "string" ? { version: 1, project: parsed.project } : { version: 1 };
    } catch {
      return { version: 1 };
    }
  }

  private write(value: CurrentFile): void {
    this.current = value;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
  }
}

export const pointerPath = (dataDir: string): string => join(dataDir, "current.json");

/** Expands a leading `~` so paths can be typed the way they are written. */
export const expandPath = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
};

export const absolutePath = (value: string, cwd: string = process.cwd()): string => {
  const expanded = expandPath(value);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
};