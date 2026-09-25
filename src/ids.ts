import { randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export const now = (): string => new Date().toISOString();
