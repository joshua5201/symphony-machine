import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const positive = z.number().int().positive();
const concurrency = z.object({
  execution_tickets: positive.default(3),
  reviews: positive.default(1),
  maintenance_scans: positive.default(1),
});
const role = z.object({
  model: z.string().default("gpt-6.1-sol"),
  reasoning: z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .default("xhigh"),
});
const schema = z.object({
  data_dir: z.string().default("~/.local/state/symphony-machine"),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().min(1).default("127.0.0.1"),
      port: positive.max(65535).default(4310),
    })
    .prefault({}),
  linear: z
    .object({
      url: z.string().url().default("https://mcp.linear.app/mcp"),
      needs_human_label: z.string().default("needs-human"),
      no_auto_pickup_label: z.string().default("no-auto-pickup"),
    })
    .prefault({}),
  codex: z
    .object({
      command: z.string().default("codex"),
      linear_mcp_server: z.string().default("linear"),
      args: z.array(z.string()).default(["app-server", "--listen", "stdio://"]),
      workflow: z.string().default("~/.agents/workflows/WORKFLOW.md"),
      lead: role.prefault({}),
      implementation: role.prefault({}),
      review: role.prefault({}),
      maintenance: role.prefault({}),
    })
    .prefault({}),
  polling: z
    .object({
      linear_seconds: positive.default(30),
      review_seconds: positive.default(60),
      github_seconds: positive.default(30),
      master_ci_seconds: positive.default(60),
    })
    .prefault({}),
  maintenance: z
    .object({
      enabled: z.boolean().default(true),
      interval_hours: z.number().positive().default(24),
      idle_only: z.boolean().default(true),
      max_open_tickets: positive.default(5),
      policy: z
        .string()
        .default(
          "Only bounded maintenance that preserves public behavior, has concrete evidence and clear acceptance criteria. No speculative abstractions or stylistic rewrites. Other proposals remain Backlog.",
        ),
    })
    .prefault({}),
  repositories: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        path: z.string(),
        github: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
        branch: z.string().default("master"),
        remote: z.string().default("origin"),
        team: z.string(),
        project: z.string(),
        worktree_root: z.string().optional(),
        required_workflows: z.array(z.string()).default([]),
        auto_merge: z.boolean().default(true),
        concurrency: concurrency.prefault({}),
        states: z
          .object({
            todo: z.string().default("Todo"),
            in_progress: z.string().default("In Progress"),
            review: z.string().default("In Review"),
            blocked: z.string().default("Blocked"),
            done: z.string().default("Done"),
            backlog: z.string().default("Backlog"),
          })
          .prefault({}),
      }),
    )
    .min(1),
});
export type Config = z.infer<typeof schema>;
export type Repo = Config["repositories"][number];
export function expand(p: string, base = process.cwd()): string {
  return resolve(
    base,
    p === "~"
      ? homedir()
      : p.startsWith("~/")
        ? resolve(homedir(), p.slice(2))
        : p,
  );
}
export function loadConfig(file: string): Config {
  const c = schema.parse(parse(readFileSync(file, "utf8")));
  const base = dirname(resolve(file));
  c.data_dir = expand(c.data_dir, base);
  c.codex.workflow = expand(c.codex.workflow, base);
  const ids = new Set<string>(),
    projects = new Set<string>();
  for (const r of c.repositories) {
    if (ids.has(r.id) || projects.has(`${r.team}/${r.project}`))
      throw new Error(
        "Repository IDs and team/project mappings must be unique",
      );
    ids.add(r.id);
    projects.add(`${r.team}/${r.project}`);
    r.path = expand(r.path, base);
    r.worktree_root = expand(
      r.worktree_root ?? `${r.path}/.symphony/worktrees`,
      base,
    );
  }
  return c;
}
export function gitConfig(r: Repo) {
  return {
    id: r.id,
    path: r.path,
    github: r.github,
    branch: r.branch,
    remote: r.remote,
    worktreeRoot: r.worktree_root!,
    requiredWorkflows: r.required_workflows,
  };
}
export function routing(c: Config, labels: string[]) {
  const value = (prefix: string, fallback: string) => {
    const found = labels
      .filter((l) => l.startsWith(prefix + "/"))
      .map((l) => l.slice(prefix.length + 1));
    if (found.length > 1) throw new Error(`Conflicting ${prefix} labels`);
    return found[0] ?? fallback;
  };
  return {
    lead: {
      model: value("Lead model", c.codex.lead.model),
      reasoning: value("Lead reasoning", c.codex.lead.reasoning),
    },
    implementation: {
      model: value("Implementation model", c.codex.implementation.model),
      reasoning: value(
        "Implementation reasoning",
        c.codex.implementation.reasoning,
      ),
    },
  };
}
