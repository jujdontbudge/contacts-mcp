import type Database from "better-sqlite3";
import { ulid } from "ulid";
export class Store {
  constructor(
    public readonly db: Database.Database,
    public readonly clock: () => Date = () => new Date(),
  ) {}
  now(): string {
    return this.clock().toISOString();
  }
  id(prefix: string): string {
    return `${prefix}_${ulid()}`;
  }
  one<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.decode(this.db.prepare(sql).get(...args)) as T | undefined;
  }
  all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((x) => this.decode(x) as T);
  }
  run(sql: string, ...args: unknown[]): void {
    this.db.prepare(sql).run(...args);
  }
  private decode(row: unknown): unknown {
    if (!row) return undefined;
    const value = { ...(row as Record<string, unknown>) };
    for (const key of [
      "aliases",
      "tags",
      "channels",
      "payload",
      "email_to",
      "email_cc",
      "email_bcc",
      "attachments",
      "raw",
    ]) {
      if (typeof value[key] === "string") value[key] = JSON.parse(value[key]);
    }
    return value;
  }
}
