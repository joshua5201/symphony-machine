import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MaintenanceScan } from "./maintenance.js";

export type Job = {
  id: string;
  repo: string;
  issueId: string;
  identifier: string;
  role: "execution" | "review" | "maintenance" | "merge";
  status: "running" | "waiting" | "blocked" | "done" | "failed";
  threadId?: string;
  // Recovery evidence retained for executions created by the old phase runner.
  workerThreadId?: string;
  phase?: "plan" | "implement" | "verify";
  handoff?: string;
  workerSummary?: string;
  workspace?: { path: string; branch: string; baseline: string };
  prNumber?: number;
  head?: string;
  // Last completed independent PR review; discussion remains on GitHub.
  reviewedHead?: string;
  fingerprint?: string;
  summary?: string;
  maintenance?: MaintenanceScan;
  createdIssueIds?: string[];
  startedAt: string;
  updatedAt: string;
};
export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL);",
    );
  }
  jobs(): Job[] {
    return (
      this.db.prepare("SELECT data FROM jobs ORDER BY rowid").all() as {
        data: string;
      }[]
    ).map((x) => JSON.parse(x.data));
  }
  save(job: Job) {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(job.id, JSON.stringify(job));
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM kv WHERE key=?").get(key) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
