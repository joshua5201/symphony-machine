import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  type CodexRunner,
  type RunInput,
  type RunResult,
} from "../src/codex.js";
import { type GitHub, type PrInfo } from "../src/github.js";
import { type LinearClient, type LinearIssue } from "../src/linear.js";
import { Machine } from "../src/machine.js";
import { Store, type Job } from "../src/store.js";
import { maintenanceDirections } from "../src/maintenance.js";

type ScopedIssue = LinearIssue & { team?: string; project?: string };

function issue(number: number, patch: Partial<ScopedIssue> = {}): ScopedIssue {
  return {
    id: `issue-${number}`,
    identifier: `ENG-${number}`,
    title: `Task ${number}`,
    description: "Implement the approved requirement.",
    state: "Todo",
    url: `https://linear.app/demo/issue/ENG-${number}`,
    labels: [],
    updatedAt: "2026-11-07T00:00:00Z",
    blockedBy: [],
    prUrls: [],
    ...patch,
  };
}

function pr(number: number, patch: Partial<PrInfo> = {}): PrInfo {
  return {
    number,
    url: `https://github.com/demo/repo/pull/${number}`,
    head: `head-${number}`,
    base: "master",
    branch: `symphony/eng-${number}`,
    state: "OPEN",
    draft: false,
    mergeable: "MERGEABLE",
    checks: "success",
    reviewDecision: "APPROVED",
    updatedAt: "2026-11-07T00:00:00Z",
    ...patch,
  };
}

function savedJob(
  value: LinearIssue,
  role: Job["role"],
  patch: Partial<Job> = {},
): Job {
  return {
    id: `${role}-${value.id}`,
    repo: "demo",
    issueId: value.id,
    identifier: value.identifier,
    role,
    status: "done",
    startedAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    ...patch,
  };
}

class FakeLinear {
  issues = new Map<string, ScopedIssue>();
  comments: { id: string; body: string }[] = [];
  updates: { id: string; patch: { state?: string; labels?: string[] } }[] = [];

  async listIssues(filter: {
    team?: string;
    project?: string;
    state?: string;
  }): Promise<LinearIssue[]> {
    return [...this.issues.values()]
      .filter((value) => !filter.team || (value.team ?? "Demo") === filter.team)
      .filter(
        (value) => !filter.project || (value.project ?? "Project") === filter.project,
      )
      .filter((value) => !filter.state || value.state === filter.state)
      .map((value) => structuredClone(value));
  }
  async getIssue(id: string): Promise<LinearIssue> {
    const value = this.issues.get(id) ?? [...this.issues.values()].find((issue) => issue.identifier === id);
    assert.ok(value, `Unknown issue ${id}`);
    return structuredClone(value);
  }
  async updateIssue(
    id: string,
    patch: { state?: string; labels?: string[] },
  ): Promise<void> {
    this.updates.push({ id, patch: structuredClone(patch) });
    const value = this.issues.get(id);
    assert.ok(value);
    if (patch.state) value.state = patch.state;
    if (patch.labels) value.labels = patch.labels;
  }
  async comment(id: string, body: string): Promise<void> {
    this.comments.push({ id, body });
  }
}

class FakeCodex {
  runs: {
    input: RunInput;
    finish: (result: Omit<RunResult, "threadId">) => void;
  }[] = [];
  async run(input: RunInput): Promise<RunResult> {
    const threadId = input.threadId ?? `thread-${this.runs.length + 1}`;
    input.onThread?.(threadId);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: Omit<RunResult, "threadId">) => {
        if (finished) return;
        finished = true;
        resolve({ threadId, ...result });
      };
      this.runs.push({ input, finish });
      input.signal?.addEventListener(
        "abort",
        () => finish({ outcome: "interrupted" }),
        { once: true },
      );
      if (input.signal?.aborted) finish({ outcome: "interrupted" });
    });
  }
}

class FakeGitHub {
  target = "master-sha";
  async targetCommit() { return this.target; }
  prs = new Map<number, PrInfo>();
  prepares: string[] = [];
  cleanups: number[] = [];
  merges: number[] = [];
  root: string;
  constructor(root: string) {
    this.root = root;
  }
  async prepare(identifier: string) {
    this.prepares.push(identifier);
    const slug = identifier.toLowerCase();
    return {
      path: join(this.root, slug),
      branch: `symphony/${slug}`,
      baseline: "base-sha",
    };
  }
  async pr(number: number): Promise<PrInfo> {
    const value = this.prs.get(number);
    assert.ok(value, `Unknown PR ${number}`);
    return structuredClone(value);
  }
  async findPr(branch: string) {
    return (
      [...this.prs.values()].find((value) => value.branch === branch) ?? null
    );
  }
  async masterHealth() {
    return { sha: "master-sha", status: "success" as const };
  }
  async updateBranch() {
    return "current" as const;
  }
  async merge(number: number) {
    this.merges.push(number);
    this.prs.get(number)!.state = "MERGED";
  }
  async cleanup(_workspace: unknown, number: number) {
    this.cleanups.push(number);
  }
}

async function fixture(
  t: TestContext,
  issues: ScopedIssue[] = [],
  additionalRepositories: { id: string; team: string; project: string }[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "symphony-machine-"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      data_dir: join(directory, "state"),
      maintenance: { enabled: false },
      polling: {
        linear_seconds: 1,
        review_seconds: 1,
        github_seconds: 1,
        master_ci_seconds: 1,
      },
      repositories: [
        {
          id: "demo",
          path: directory,
          github: "demo/repo",
          branch: "master",
          team: "Demo",
          project: "Project",
          worktree_root: join(directory, "worktrees"),
          auto_merge: false,
        },
        ...additionalRepositories.map((repo) => ({
          ...repo,
          path: join(directory, repo.id),
          github: `demo/${repo.id}`,
          branch: "master",
          auto_merge: false,
        })),
      ],
    }),
  );
  const config = loadConfig(configPath);
  const database = join(directory, "state", "machine.sqlite");
  let store = new Store(database);
  const linear = new FakeLinear();
  for (const value of issues)
    linear.issues.set(value.id, structuredClone(value));
  const codex = new FakeCodex();
  const githubs = new Map(
    config.repositories.map((repo) => [repo.id, new FakeGitHub(repo.worktree_root!)]),
  );
  const githubFor = (id: string) => {
    const github = githubs.get(id);
    assert.ok(github, `Unknown repository ${id}`);
    return github;
  };
  const github = githubFor("demo");
  const logs: { event: string; details: unknown }[] = [];
  const makeMachine = () =>
    new Machine(
      config,
      store,
      linear as unknown as LinearClient,
      codex as unknown as CodexRunner,
      (event, details) => logs.push({ event, details }),
      (repo) => githubFor(repo.id) as unknown as GitHub,
    );
  let machine = makeMachine();
  t.after(async () => {
    machine.stop(true);
    await machine.drain();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    config,
    linear,
    codex,
    github,
    githubFor,
    logs,
    get machine() {
      return machine;
    },
    get store() {
      return store;
    },
    restart() {
      assert.equal(machine.activeCount, 0);
      store.close();
      store = new Store(database);
      machine = makeMachine();
      machine.recover();
      return machine;
    },
  };
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Coordinator did not reach the expected state");
}

test("dashboard groups tickets and live agents by project and retains maintenance findings across restart", async (t) => {
  const direct = issue(1, { labels: ["Symphony mode/Direct"] });
  const delegated = issue(2, { team: "Other", project: "Second" });
  const review = issue(3, { state: "In Review", prUrls: [pr(3).url] });
  const inactive = issue(99, { state: "Blocked" });
  const f = await fixture(
    t,
    [direct, delegated, review, inactive],
    [{ id: "other", team: "Other", project: "Second" }],
  );
  f.github.prs.set(3, pr(3));
  f.store.save(savedJob(issue(99), "review", { status: "running" }));
  for (const [index, repo] of ["demo", "other", "demo"].entries()) {
    f.store.save({
      ...savedJob(issue(90 + index), "maintenance"),
      id: `scan-${index}`,
      repo,
      status: index === 2 ? "failed" : "done",
      summary:
        index === 2 ? "Investigation incomplete." : "No justified findings.",
      maintenance: {
        direction: maintenanceDirections[index].id,
        to: `commit-${index}`,
      },
    });
  }
  await f.machine.tick(1000);
  await until(() => f.codex.runs.length === 3);
  const jobsBefore = f.store.jobs();
  const snapshot = f.machine.dashboard();
  const [first, second] = snapshot.projects;
  assert.deepEqual(
    first.tickets
      .filter((ticket) => ticket.agentStatus === "running")
      .map(({ identifier, mode, role }) => ({ identifier, mode, role }))
      .sort((a, b) => a.identifier.localeCompare(b.identifier)),
    [
      { identifier: direct.identifier, mode: "Direct", role: "execution" },
      { identifier: review.identifier, mode: "Delegated", role: "review" },
    ],
  );
  assert.deepEqual(
    second.tickets.map(({ identifier, mode }) => ({ identifier, mode })),
    [{ identifier: delegated.identifier, mode: "Delegated" }],
  );
  const activeDirect = first.tickets.find(
    (ticket) => ticket.identifier === direct.identifier,
  )!;
  assert.equal(activeDirect.title, direct.title);
  assert.equal(activeDirect.url, direct.url);
  assert.deepEqual(
    first.maintenance.map(({ id, theme, status, summary }) => ({
      id,
      theme,
      status,
      summary,
    })),
    [
      {
        id: "scan-2",
        theme: maintenanceDirections[2].focus,
        status: "failed",
        summary: "Investigation incomplete.",
      },
      {
        id: "scan-0",
        theme: maintenanceDirections[0].focus,
        status: "done",
        summary: "No justified findings.",
      },
    ],
  );
  assert.deepEqual(
    second.maintenance.map(({ id }) => id),
    ["scan-1"],
  );
  assert.deepEqual(
    f.store.jobs(),
    jobsBefore,
    "viewing does not change persisted jobs",
  );
  const serialized = JSON.stringify(snapshot);
  const withoutCommands = snapshot.projects.flatMap((project) =>
    project.tickets.map(({ resumeCommand, ...ticket }) => ticket),
  );
  assert.ok(!JSON.stringify(withoutCommands).includes(f.config.data_dir));
  assert.ok(!serialized.includes(direct.description));
  assert.ok(!serialized.includes("threadId"));
  f.machine.stop(true);
  await f.machine.drain();
  assert.ok(
    f.machine
      .dashboard()
      .projects.every((p) =>
        p.tickets.every((ticket) => ticket.agentStatus !== "running"),
      ),
  );
  f.restart();
  assert.deepEqual(
    f.machine.dashboard().projects.map((p) => p.maintenance),
    snapshot.projects.map((p) => p.maintenance),
  );
});

test("kanban shows all Todo and handled tickets with independent Linear and agent state, event times, and session commands", async (t) => {
  const finishedAt = "2026-11-08T12:10:00Z";
  const blockedAt = "2026-11-07T08:00:00Z";
  const tasks = [
    issue(1),
    issue(2, { labels: ["human-review"] }),
    issue(3, { state: "Delivered", completedAt: finishedAt }),
    issue(4, {
      state: "Blocked",
      stateHistory: [
        { state: "Blocked", startedAt: blockedAt },
        { state: "Blocked", startedAt: "2026-11-01T08:00:00Z" },
        { state: "In Progress", startedAt: "2026-11-09T08:00:00Z" },
      ],
    }),
    issue(5, { state: "In Review" }),
    issue(6, { state: "Delivered" }),
    issue(7, { state: "Canceled" }),
    issue(8, { state: "Blocked" }),
    issue(9, { state: "Backlog" }),
  ];
  const f = await fixture(t, tasks);
  f.store.set("pause:all", true);
  f.config.linear.needs_human_label = "human-review";
  f.config.repositories[0].states.done = "Delivered";
  f.config.repositories[0].path += "/owner's repo";
  for (const index of [2, 3, 4, 6, 7])
    f.store.save(
      savedJob(tasks[index], "execution", {
        status: index === 3 ? "failed" : "done",
        threadId: index === 3 ? "broken-session" : undefined,
      }),
    );
  f.store.save(savedJob(tasks[4], "review", { status: "done" }));
  f.store.save(
    savedJob(issue(90), "maintenance", {
      createdIssueIds: [tasks[8].identifier, tasks[0].identifier],
    }),
  );
  const jobsBefore = f.store.jobs();
  await f.machine.tick(1000);
  const project = f.machine.dashboard().projects[0];
  assert.deepEqual(project.tickets.map((ticket) => ticket.identifier).sort(), [
    "ENG-1",
    "ENG-2",
    "ENG-3",
    "ENG-4",
    "ENG-5",
    "ENG-7",
    "ENG-8",
    "ENG-9",
  ]);
  const byId = (id: string) =>
    project.tickets.find((ticket) => ticket.identifier === id)!;
  assert.equal(byId("ENG-1").column, "todo");
  assert.equal(byId("ENG-1").agentStatus, null);
  assert.equal(byId("ENG-1").resumeCommand, null);
  assert.equal(byId("ENG-2").needsHumanReview, true);
  assert.equal(byId("ENG-3").column, "done");
  assert.equal(byId("ENG-3").completedAt, finishedAt);
  assert.equal(byId("ENG-4").column, "blocked");
  assert.equal(byId("ENG-4").agentStatus, "failed");
  assert.equal(byId("ENG-4").blockedAt, blockedAt);
  assert.equal(
    byId("ENG-4").resumeCommand,
    `codex resume broken-session --cd '${f.config.repositories[0].path.slice(0, -"owner's repo".length)}owner'"'"'s repo'`,
  );
  assert.equal(byId("ENG-5").column, "review");
  assert.equal(byId("ENG-5").agentStatus, "done");
  assert.equal(byId("ENG-5").completedAt, null);
  assert.equal(byId("ENG-7").column, "other");
  assert.equal(byId("ENG-8").blockedAt, null);
  assert.equal(byId("ENG-9").column, "other");
  assert.equal(project.ticketsStale, false);
  assert.ok(project.ticketsUpdatedAt);
  assert.deepEqual(f.store.jobs(), jobsBefore);
  assert.deepEqual(f.linear.updates, []);
  assert.deepEqual(f.linear.comments, []);
  assert.equal(f.codex.runs.length, 0);

  f.restart();
  await f.machine.tick(1000);
  assert.deepEqual(f.machine.dashboard().projects[0].tickets, project.tickets);
});

test("kanban retains its last Linear snapshot and marks it stale on a read failure", async (t) => {
  const task = issue(1, { state: "Blocked" });
  const f = await fixture(t, [task]);
  f.store.set("pause:all", true);
  f.store.save(savedJob(task, "execution", { status: "failed" }));
  await f.machine.tick(1000);
  const before = f.machine.dashboard().projects[0];
  f.linear.getIssue = async () => {
    throw new Error("Read unavailable");
  };
  await f.machine.tick(2001);
  const after = f.machine.dashboard().projects[0];
  assert.deepEqual(after.tickets, before.tickets);
  assert.equal(after.ticketsStale, true);
  assert.deepEqual(f.linear.updates, []);
});

test("dashboard listener configuration changes require restart", async (t) => {
  const f = await fixture(t);
  const next = structuredClone(f.config);
  next.dashboard.port++;
  assert.throws(() => f.machine.reload(next), /require restart/);
  assert.equal(f.machine.config.dashboard.port, f.config.dashboard.port);
});
