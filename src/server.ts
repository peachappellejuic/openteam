import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { createStore, type JsonStore } from "./store.js";
import type { CreateProjectInput, CreateTaskInput, PlanInput } from "./types.js";

class HttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const json = (response: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > config.maxBodyBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
};

const stringValue = (body: Record<string, unknown>, key: string, required = true): string => {
  const value = body[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  return value;
};

const stringArray = (body: Record<string, unknown>, key: string): string[] => {
  const value = body[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, `${key} must be an array of strings`);
  return value as string[];
};

const tokenMatches = (provided: string, expected: string): boolean => {
  const candidate = Buffer.from(provided);
  const reference = Buffer.from(expected);
  if (candidate.length !== reference.length) return false;
  return timingSafeEqual(candidate, reference);
};

const readToken = (request: IncomingMessage): string => {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const custom = request.headers["x-agentswarm-token"];
  if (typeof custom === "string") return custom.trim();
  return "";
};

const requireToken = (request: IncomingMessage, url: URL, allowQueryToken = false): void => {
  if (!config.sharedTokenRequired) return;
  const provided = readToken(request) || (allowQueryToken ? url.searchParams.get("token")?.trim() ?? "" : "");
  if (!provided || !tokenMatches(provided, config.sharedToken)) {
    throw new HttpError(401, "A valid shared access token is required");
  }
};

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const serveStatic = async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> => {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = resolve(join(config.publicDir, requested));
  const publicRoot = resolve(config.publicDir);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
  } catch {
    filePath = join(publicRoot, "index.html");
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(content);
  } catch {
    json(response, 404, { error: "Not found" });
  }
};

const openEventStream = (request: IncomingMessage, response: ServerResponse, store: JsonStore, projectId?: string): void => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);
  const send = (event: unknown): void => {
    if (projectId && (event as { projectId?: string }).projectId && (event as { projectId?: string }).projectId !== projectId) return;
    response.write(`event: update\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = store.subscribe(send);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

const parseProjectInput = (body: Record<string, unknown>): CreateProjectInput => ({
  name: stringValue(body, "name"),
  repositoryPath: stringValue(body, "repositoryPath"),
  defaultBranch: stringValue(body, "defaultBranch", false) || undefined,
});

const parseTaskInput = (body: Record<string, unknown>): CreateTaskInput => ({
  title: stringValue(body, "title"),
  description: stringValue(body, "description"),
  assignee: stringValue(body, "assignee", false) || undefined,
  provider: typeof body.provider === "string" ? body.provider as CreateTaskInput["provider"] : undefined,
  model: stringValue(body, "model", false) || undefined,
  dependencies: stringArray(body, "dependencies"),
  allowedPaths: stringArray(body, "allowedPaths"),
  acceptanceTests: stringArray(body, "acceptanceTests"),
  verifyCommand: stringValue(body, "verifyCommand", false) || undefined,
  parentId: stringValue(body, "parentId", false) || undefined,
});

const parsePlanInput = (body: Record<string, unknown>): PlanInput => {
  const rawTasks = body.tasks;
  const tasks = Array.isArray(rawTasks)
    ? rawTasks.filter((task): task is Record<string, unknown> => Boolean(task && typeof task === "object")).map((task) => ({
        title: stringValue(task, "title"),
        description: stringValue(task, "description"),
        assignee: stringValue(task, "assignee", false) || undefined,
        provider: typeof task.provider === "string" ? task.provider as CreateTaskInput["provider"] : undefined,
        dependencies: stringArray(task, "dependencies"),
        allowedPaths: stringArray(task, "allowedPaths"),
        acceptanceTests: stringArray(task, "acceptanceTests"),
        verifyCommand: stringValue(task, "verifyCommand", false) || undefined,
      }))
    : undefined;
  return { goal: stringValue(body, "goal"), tasks };
};

export const createAppServer = (store: JsonStore = createStore(), orchestrator = new Orchestrator(store)) => {
  const server = createHttpServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-agentswarm-token");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    try {
      if (parts[0] !== "api") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed");
        await serveStatic(request, response, url.pathname);
        return;
      }

      if (parts[1] === "health" && request.method === "GET") {
        json(response, 200, { ok: true, service: "agentswarm" });
        return;
      }
      requireToken(request, url, parts[1] === "projects" && parts[3] === "events");
      if (parts[1] === "providers" && request.method === "GET") {
        json(response, 200, { providers: await orchestrator.getProviders() });
        return;
      }
      if (parts[1] === "projects" && parts.length === 2 && request.method === "GET") {
        json(response, 200, { projects: orchestrator.listProjects() });
        return;
      }
      if (parts[1] === "projects" && parts.length === 2 && request.method === "POST") {
        json(response, 201, { project: await orchestrator.createProject(parseProjectInput(await readBody(request))) });
        return;
      }

      if (parts[1] === "projects" && parts[3] === "snapshot" && request.method === "GET") {
        json(response, 200, orchestrator.getSnapshot(parts[2]));
        return;
      }
      if (parts[1] === "projects" && parts[3] === "events" && request.method === "GET") {
        openEventStream(request, response, store, parts[2]);
        return;
      }
      if (parts[1] === "projects" && parts[3] === "sync" && request.method === "POST") {
        json(response, 200, { sync: await orchestrator.syncProject(parts[2]) });
        return;
      }
      if (parts[1] === "projects" && parts[3] === "tasks" && request.method === "GET") {
        json(response, 200, { tasks: store.listTasks(parts[2]) });
        return;
      }
      if (parts[1] === "projects" && parts[3] === "tasks" && request.method === "POST") {
        json(response, 201, { task: await orchestrator.createTask(parts[2], parseTaskInput(await readBody(request))) });
        return;
      }
      if (parts[1] === "projects" && parts[3] === "plan" && request.method === "POST") {
        json(response, 201, { tasks: await orchestrator.createPlan(parts[2], parsePlanInput(await readBody(request))) });
        return;
      }
      if (parts[1] === "projects" && parts[3] === "dispatch" && request.method === "POST") {
        await orchestrator.dispatchReadyTasks(parts[2]);
        json(response, 202, { ok: true });
        return;
      }

      if (parts[1] === "tasks" && parts.length === 3 && request.method === "GET") {
        const task = store.getTask(parts[2]);
        if (!task) throw new HttpError(404, "Task not found");
        json(response, 200, {
          task,
          runs: store.listRuns(task.projectId).filter((run) => run.taskId === task.id),
          changes: store.listChanges(task.projectId).filter((change) => change.taskId === task.id),
        });
        return;
      }
      if (parts[1] === "tasks" && parts[3] === "dispatch" && request.method === "POST") {
        json(response, 202, { task: await orchestrator.dispatchTask(parts[2]) });
        return;
      }
      if (parts[1] === "tasks" && parts[3] === "cancel" && request.method === "POST") {
        json(response, 200, { task: await orchestrator.cancelTask(parts[2]) });
        return;
      }
      if (parts[1] === "tasks" && parts[3] === "assign" && request.method === "POST") {
        const body = await readBody(request);
        json(response, 200, { task: await orchestrator.assignTask(parts[2], stringValue(body, "assignee", false)) });
        return;
      }

      if (parts[1] === "changes" && parts.length === 3 && request.method === "GET") {
        const change = store.getChange(parts[2]);
        if (!change) throw new HttpError(404, "Change not found");
        json(response, 200, { change });
        return;
      }
      if (parts[1] === "changes" && parts[3] === "approve" && request.method === "POST") {
        json(response, 200, { change: await orchestrator.approveChange(parts[2]) });
        return;
      }
      if (parts[1] === "changes" && parts[3] === "merge" && request.method === "POST") {
        json(response, 200, { change: await orchestrator.mergeChange(parts[2]) });
        return;
      }

      throw new HttpError(404, "Route not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof Error && /not found/i.test(error.message) ? 404 : 400;
      const message = error instanceof Error ? error.message : "Request failed";
      if (status >= 500) console.error(error);
      json(response, status, { error: message });
    }
  });
  return { server, store, orchestrator };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (config.sharedTokenMissing) {
    console.error(
      `Refusing to listen on ${config.host}: set AGENTSWARM_SHARED_TOKEN before binding a non-loopback address.`,
    );
    process.exit(1);
  }
  const app = createAppServer();
  app.server.listen(config.port, config.host, () => {
    const authNote = config.sharedTokenRequired ? " (shared token required)" : " (loopback only, no token)";
    console.log(`AgentSwarm listening on http://localhost:${config.port}${authNote}`);
  });
  const shutdown = async (): Promise<void> => {
    await app.orchestrator.shutdown();
    app.server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
