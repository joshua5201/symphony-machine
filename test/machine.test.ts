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

function issue(number: number, patch: Partial<LinearIssue> = {}): LinearIssue {
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
  issues = new Map<string, LinearIssue>();
  comments: { id: string; body: string }[] = [];

  async listIssues(filter: { state?: string }): Promise<LinearIssue[]> {
    return [...this.issues.values()]
      .filter((value) => !filter.state || value.state === filter.state)
      .map((value) => structuredClone(value));
  }
  async getIssue(id: string): Promise<LinearIssue> {
    const value = this.issues.get(id);
    assert.ok(value, `Unknown issue ${id}`);
    return structuredClone(value);
  }
  async updateIssue(
    id: string,
    patch: { state?: string; labels?: string[] },
  ): Promise<void> {
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

async function fixture(t: TestContext, issues: LinearIssue[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "symphony-machine-"));
  const configPath = join(directory, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      data_dir: join(directory, "state"),
      codex: { mode: "direct" },
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
  const github = new FakeGitHub(join(directory, "worktrees"));
  const logs: { event: string; details: unknown }[] = [];
  const makeMachine = () =>
    new Machine(
      config,
      store,
      linear as unknown as LinearClient,
      codex as unknown as CodexRunner,
      (event, details) => logs.push({ event, details }),
      () => github as unknown as GitHub,
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

test("dependencies require Done plus a PR merged into its configured target or explicit no-PR delivery", async (t) => {
  const dependency = issue(1, { state: "Done" });
  const dependent = issue(2, {
    blockedBy: [
      { id: dependency.id, identifier: dependency.identifier, state: "Done" },
    ],
  });
  const f = await fixture(t, [dependency, dependent]);
  const repo = f.config.repositories[0];
  assert.equal(
    await f.machine.dependenciesReady(dependent, repo),
    false,
    "Done alone is insufficient evidence of delivery",
  );
  f.linear.issues.get(dependency.id)!.description += "\n[No PR required]";
  assert.equal(await f.machine.dependenciesReady(dependent, repo), true);
  f.linear.issues.get(dependency.id)!.prUrls = [pr(1).url];
  f.github.prs.set(1, pr(1));
  assert.equal(
    await f.machine.dependenciesReady(dependent, repo),
    false,
    "an open PR is not delivered",
  );
  f.github.prs.set(1, pr(1, { state: "MERGED", base: "release" }));
  assert.equal(
    await f.machine.dependenciesReady(dependent, repo),
    false,
    "merge into another target does not unblock this dependency",
  );
  f.github.prs.set(1, pr(1, { state: "MERGED" }));
  assert.equal(await f.machine.dependenciesReady(dependent, repo), true);
});

test("admits three independent executions and hot lowering the cap leaves active work running", async (t) => {
  const f = await fixture(
    t,
    [1, 2, 3, 4, 5].map((number) => issue(number)),
  );
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 3);
  assert.equal(f.machine.activeCount, 3);
  assert.equal(
    f.store.jobs().filter((job) => job.status === "running").length,
    3,
  );
  f.machine.reload({
    ...f.config,
    concurrency: { ...f.config.concurrency, execution_tickets: 1 },
  });
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 3);
  assert.ok(f.codex.runs.every((run) => !run.input.signal?.aborted));
  assert.equal(f.machine.activeCount, 3);
});

test("interrupted execution persists waiting and resumes the same thread and worktree after restart", async (t) => {
  const task = issue(1);
  const f = await fixture(t, [task]);
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  const before = f.store.jobs()[0];
  f.machine.stop(true);
  await f.machine.drain();
  assert.equal(f.store.jobs()[0].status, "waiting");
  assert.equal(f.linear.issues.get(task.id)?.state, "In Progress");
  f.restart();
  await f.machine.tick(3_000);
  assert.deepEqual(
    f.logs.filter((log) => log.event === "poll_error"),
    [],
  );
  await until(() => f.codex.runs.length === 2);
  assert.equal(f.codex.runs[1].input.threadId, before.threadId);
  assert.equal(f.codex.runs[1].input.cwd, before.workspace?.path);
  assert.deepEqual(f.github.prepares, [task.identifier]);
  f.codex.runs[1].finish({
    outcome: "completed",
    result: {
      decision: "review",
      summary: "Verified the resumed work.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  assert.equal(f.store.jobs()[0].status, "done");
  assert.equal(f.linear.issues.get(task.id)?.state, "In Review");
});

test("startup recovery resumes an execution left running in SQLite instead of creating another job", async (t) => {
  const task = issue(1, { state: "In Progress" });
  const f = await fixture(t, [task]);
  const workspace = await f.github.prepare(task.identifier);
  const old = savedJob(task, "execution", {
    status: "running",
    threadId: "existing-thread",
    workspace,
    phase: "plan",
  });
  f.store.save(old);
  f.restart();
  assert.equal(f.store.jobs()[0].status, "waiting");
  await f.machine.tick(1_000);
  assert.deepEqual(
    f.logs.filter((log) => log.event === "poll_error"),
    [],
  );
  await until(() => f.codex.runs.length === 1);
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].id, old.id);
  assert.equal(f.codex.runs[0].input.threadId, "existing-thread");
  assert.equal(f.codex.runs[0].input.cwd, workspace.path);
  assert.deepEqual(f.github.prepares, [task.identifier]);
});

test("graceful stop allows active execution to finish and does not admit queued tickets", async (t) => {
  const f = await fixture(t, [issue(1), issue(2)]);
  f.config.concurrency.execution_tickets = 1;
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.machine.stop();
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.codex.runs[0].input.signal?.aborted, false);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: { decision: "review", summary: "Ready for review.", prNumber: 1 },
  });
  await f.machine.drain();
  assert.equal(f.machine.activeCount, 0);
  assert.equal(f.linear.issues.get("issue-1")?.state, "In Review");
  assert.equal(f.linear.issues.get("issue-2")?.state, "Todo");
});

test("merged cleanup waits until an active review for the same issue has finished", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  const workspace = await f.github.prepare(task.identifier);
  f.store.save(savedJob(task, "execution", { workspace, prNumber: 1 }));
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.github.prs.set(1, pr(1, { state: "MERGED" }));
  await f.machine.tick(3_000);
  assert.deepEqual(f.github.cleanups, []);
  assert.equal(f.linear.issues.get(task.id)?.state, "In Review");
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "ready_to_merge",
      summary: "Delivery requirements verified.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  await f.machine.tick(5_000);
  await f.machine.flush();
  assert.deepEqual(f.github.cleanups, [1]);
  assert.equal(f.linear.issues.get(task.id)?.state, "Done");
  await f.machine.tick(7_000);
  assert.deepEqual(f.github.cleanups, [1], "completed cleanup is not repeated");
});

test("a merge decision made before a ticket update cannot authorize merging the unchanged PR head", async (t) => {
  const task = issue(1, {
    state: "In Review",
    prUrls: [pr(1).url],
    updatedAt: "2026-11-07T01:00:00Z",
  });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1));
  f.store.save(
    savedJob(task, "review", {
      prNumber: 1,
      head: "head-1",
      fingerprint: `head-1:${pr(1).updatedAt}:${task.updatedAt}`,
    }),
  );
  f.store.set("merge:demo:issue-1", {
    issueId: task.id,
    pr: 1,
    head: "head-1",
    summary: "Approved earlier requirements.",
    updatedAt: "2026-11-07T00:00:00Z",
    prUpdatedAt: pr(1).updatedAt,
  });
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "done",
      summary: "Merge this approved candidate first.",
      issueIds: [task.id],
    },
  });
  await f.machine.drain();
  await f.machine.tick(3_000);
  assert.deepEqual(f.github.merges, []);
  assert.equal(f.store.get("merge:demo:issue-1"), null);
  await until(() => f.codex.runs.length === 2);
});

test("an execution completing while outbox delivery awaits Linear keeps its state update and comment", async (t) => {
  const f = await fixture(t, [issue(1), issue(2, { state: "Blocked" })]);
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.store.set("outbox", [
    { id: "earlier-note", issueId: "issue-2", comment: "Earlier queued note." },
  ]);
  let release!: () => void;
  let deliveryStarted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const comment = f.linear.comment.bind(f.linear);
  f.linear.comment = async (id, body) => {
    if (body === "Earlier queued note.") {
      deliveryStarted = true;
      await gate;
    }
    await comment(id, body);
  };
  const flushing = f.machine.flush();
  try {
    await until(() => deliveryStarted);
    f.codex.runs[0].finish({
      outcome: "completed",
      result: {
        decision: "review",
        summary: "Finished while Linear was pending.",
        prNumber: 1,
      },
    });
    await until(() => f.machine.activeCount === 0);
  } finally {
    release();
    await flushing;
  }
  assert.equal(f.linear.issues.get("issue-1")?.state, "In Review");
  assert.deepEqual(
    f.linear.comments.map((value) => value.id),
    ["issue-2", "issue-1"],
  );
  assert.match(f.linear.comments[1].body, /Finished while Linear was pending/);
  assert.deepEqual(f.store.get("outbox"), []);
});

test("startup recovery resumes a review interrupted before its unchanged fingerprint completed", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.github.prs.set(1, pr(1));
  const old = savedJob(task, "review", {
    status: "running",
    threadId: "interrupted-review-thread",
    prNumber: 1,
    head: "head-1",
    fingerprint: `head-1:${pr(1).updatedAt}:${task.updatedAt}`,
  });
  f.store.save(old);
  f.restart();
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].id, old.id);
  assert.equal(f.codex.runs[0].input.threadId, "interrupted-review-thread");
  assert.equal(f.store.jobs()[0].status, "running");
});

test("a merge planner and newly eligible reviews share the configured review capacity", async (t) => {
  const candidate = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const waitingReview = issue(2, { state: "In Review", prUrls: [pr(2).url] });
  const f = await fixture(t, [candidate, waitingReview]);
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1));
  f.github.prs.set(2, pr(2));
  f.store.save(
    savedJob(candidate, "review", {
      prNumber: 1,
      fingerprint: `head-1:${pr(1).updatedAt}:${candidate.updatedAt}`,
    }),
  );
  f.store.set("merge:demo:issue-1", {
    issueId: candidate.id,
    pr: 1,
    head: "head-1",
    summary: "Approved.",
    updatedAt: candidate.updatedAt,
    prUpdatedAt: pr(1).updatedAt,
  });
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length >= 1);
  assert.equal(
    f.codex.runs.length,
    1,
    "a planner occupying the one shared slot defers the new review",
  );
  assert.equal(f.machine.activeCount, 1);
  assert.equal(
    f.store.jobs().filter((job) => job.status === "running")[0].role,
    "merge",
  );
});

test("a pending merge planner is not duplicated on later polls when spare review capacity exists", async (t) => {
  const candidate = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [candidate]);
  f.config.repositories[0].auto_merge = true;
  f.config.concurrency.reviews = 2;
  f.github.prs.set(1, pr(1));
  f.store.save(
    savedJob(candidate, "review", {
      prNumber: 1,
      fingerprint: `head-1:${pr(1).updatedAt}:${candidate.updatedAt}`,
    }),
  );
  f.store.set("merge:demo:issue-1", {
    issueId: candidate.id,
    pr: 1,
    head: "head-1",
    summary: "Approved.",
    updatedAt: candidate.updatedAt,
    prUpdatedAt: pr(1).updatedAt,
  });
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.store.jobs().filter((job) => job.role === "merge").length, 1);
  assert.equal(f.codex.runs[0].input.signal?.aborted, false);
});

test("CI-only recovery may complete without a PR after independent target verification", async (t) => {
  const incident = issue(70, { title: "[CI repair] demo target" });
  const f = await fixture(t, [incident]);
  f.config.codex.mode = "delegated";
  f.store.set("repair:demo", incident.id);
  await f.machine.tick(1000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "done",
      summary: "The transient job retry passed on current target.",
    },
  });
  await until(() => f.machine.activeCount === 0);
  await f.machine.flush();
  assert.equal(f.linear.issues.get(incident.id)!.state, "Done");
  assert.equal(f.store.get(`no_pr:${incident.id}`), true);
  assert.deepEqual(f.github.merges, []);
  assert.deepEqual(
    f.github.cleanups,
    [],
    "unmerged diagnostic workspace is retained",
  );
});

test("reloaded polling and maintenance intervals affect the next scheduling round", async (t) => {
  const f = await fixture(t);
  let polls = 0;
  const list = f.linear.listIssues.bind(f.linear);
  f.linear.listIssues = async (filter) => {
    polls++;
    return list(filter);
  };
  await f.machine.tick(1000);
  const before = polls;
  f.store.set("maintenance_next:demo", 1000 + 24 * 3600000);
  const next = structuredClone(f.config);
  next.polling.linear_seconds = 2;
  next.maintenance.interval_hours = 2;
  f.machine.reload(next);
  await f.machine.tick(1001);
  assert.ok(polls > before, "old poll deadline is replaced on reload");
  assert.equal(f.store.get("maintenance_next:demo"), 1000 + 2 * 3600000);
});
