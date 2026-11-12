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
        (value) =>
          !filter.project || (value.project ?? "Project") === filter.project,
      )
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
    this.updates.push({ id, patch: structuredClone(patch) });
    const value = this.issues.get(id);
    assert.ok(value);
    if (patch.state) value.state = patch.state;
    if (patch.labels) value.labels = patch.labels;
    value.updatedAt = new Date(
      Date.parse(value.updatedAt) + 1000,
    ).toISOString();
  }
  async comment(id: string, body: string): Promise<void> {
    this.comments.push({ id, body });
  }
}

class FakeCodex {
  constructor(private readonly onRun: (input: RunInput) => void = () => {}) {}
  runs: {
    input: RunInput;
    finish: (result: Omit<RunResult, "threadId">) => void;
  }[] = [];
  async run(input: RunInput): Promise<RunResult> {
    const threadId = input.threadId ?? `thread-${this.runs.length + 1}`;
    input.onThread?.(threadId);
    this.onRun(input);
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
  async targetCommit() {
    return this.target;
  }
  prs = new Map<number, PrInfo>();
  reviewFingerprints = new Map<number, string>();
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
  async reviewContext(number: number) {
    return {
      fingerprint: this.reviewFingerprints.get(number) ?? `context-${number}`,
      reviews: [],
      comments: [],
      inlineComments: [],
    };
  }
  async findPr(branch: string) {
    return (
      [...this.prs.values()].find((value) => value.branch === branch) ?? null
    );
  }
  async masterHealth() {
    return { sha: "master-sha", status: "success" as const };
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
  const codex = new FakeCodex((input) => {
    if (input.outputFormat !== "text") return;
    const task = [...linear.issues.values()].find(
      (value) => input.title === `${value.identifier} · Lead`,
    );
    // The invoked skill owns this transition; controller writes are tracked
    // separately by FakeLinear.updateIssue.
    if (task?.state === "Todo") task.state = "In Progress";
  });
  const githubs = new Map(
    config.repositories.map((repo) => [
      repo.id,
      new FakeGitHub(repo.worktree_root!),
    ]),
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

test("maintenance rotates directions with independent successful commit checkpoints across restart", async (t) => {
  const f = await fixture(t);
  f.config.maintenance.enabled = true;
  const interval = f.config.maintenance.interval_hours * 3600000;
  let now = 1000;
  for (const [index, direction] of maintenanceDirections.entries()) {
    f.github.target = `commit-${index}`;
    await f.machine.tick(now);
    await until(() => f.codex.runs.length === index + 1);
    const job = f.store.jobs().findLast((j) => j.role === "maintenance")!;
    assert.deepEqual(job.maintenance, {
      direction: direction.id,
      to: `commit-${index}`,
    });
    f.codex.runs[index].finish({
      outcome: "completed",
      result: { decision: "done", summary: "No justified findings." },
    });
    await f.machine.drain();
    now += interval;
  }
  f.restart();
  f.github.target = "new-head";
  await f.machine.tick(now);
  await until(() => f.codex.runs.length === maintenanceDirections.length + 1);
  assert.deepEqual(f.store.jobs().at(-1)!.maintenance, {
    direction: maintenanceDirections[0].id,
    from: "commit-0",
    to: "new-head",
  });
  f.codex.runs
    .at(-1)!
    .finish({ outcome: "failed", error: "Investigation incomplete" });
  await f.machine.drain();
  now += interval;
  // Other directions retain their own checkpoints and skip unchanged heads
  // without spending an agent turn. A failed direction still yields its turn.
  const runs = f.codex.runs.length;
  for (let index = 1; index < maintenanceDirections.length; index++) {
    f.github.target = `commit-${index}`;
    await f.machine.tick(now);
    await f.machine.drain();
    assert.equal(f.codex.runs.length, runs);
    assert.equal(
      f.store.jobs().at(-1)!.maintenance!.direction,
      maintenanceDirections[index].id,
    );
    now += interval;
  }
  f.restart();
  f.github.target = "newer-head";
  await f.machine.tick(now);
  await until(() => f.codex.runs.length === runs + 1);
  assert.deepEqual(
    f.store.jobs().at(-1)!.maintenance,
    {
      direction: maintenanceDirections[0].id,
      from: "commit-0",
      to: "newer-head",
    },
    "failed investigation must not advance its checkpoint",
  );
  f.codex.runs.at(-1)!.finish({
    outcome: "completed",
    result: { decision: "done", summary: "Complete." },
  });
  await f.machine.drain();
});

test("interrupted maintenance resumes the same direction, commit range and thread before advancing", async (t) => {
  const f = await fixture(t);
  f.config.maintenance.enabled = true;
  await f.machine.tick(1000);
  await until(() => f.codex.runs.length === 1);
  const original = f.store.jobs().at(-1)!;
  f.machine.stop(true);
  await f.machine.drain();
  f.restart();
  f.github.target = "advanced-during-interruption";
  await f.machine.tick(2000);
  await until(() => f.codex.runs.length === 2);
  const resumed = f.store.jobs().at(-1)!;
  assert.equal(resumed.id, original.id);
  assert.deepEqual(resumed.maintenance, original.maintenance);
  assert.equal(f.codex.runs[1].input.threadId, original.threadId);
  f.codex.runs[1].finish({
    outcome: "completed",
    result: { decision: "done", summary: "Completed pinned snapshot." },
  });
  await f.machine.drain();
  assert.equal(f.store.jobs().at(-1)!.maintenance!.to, "master-sha");
});

test("maintenance capacity and idle checks apply independently to each repository", async (t) => {
  const execution = issue(1);
  const otherPr = pr(2, { url: "https://github.com/demo/other/pull/2" });
  const review = issue(2, {
    team: "Other",
    project: "Other Project",
    state: "In Review",
    prUrls: [otherPr.url],
  });
  const f = await fixture(
    t,
    [execution, review],
    [
      { id: "other", team: "Other", project: "Other Project" },
      { id: "idle", team: "Idle", project: "Idle Project" },
    ],
  );
  f.config.maintenance.enabled = true;
  f.config.repositories[0].concurrency.execution_tickets = 1;
  f.githubFor("other").prs.set(2, otherPr);
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 3);
  const running = () =>
    f.store.jobs().filter((job) => job.status === "running");
  const scanning = () =>
    running()
      .filter((job) => job.role === "maintenance")
      .map((job) => job.repo)
      .sort();
  assert.deepEqual(
    running().map((job) => ({ repo: job.repo, role: job.role })),
    [
      { repo: "demo", role: "execution" },
      { repo: "other", role: "review" },
      { repo: "idle", role: "maintenance" },
    ],
  );

  f.codex.runs
    .find((run) => run.input.title === `${review.identifier} · Review`)!
    .finish({
      outcome: "completed",
      result: { decision: "ready_to_merge", summary: "Verified.", prNumber: 2 },
    });
  await until(() => f.machine.activeCount === 2);
  await f.machine.flush();
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 4);
  assert.deepEqual(scanning(), ["idle", "other"]);

  f.linear.issues.get(execution.id)!.state = "Blocked";
  f.codex.runs
    .find((run) => run.input.title === `${execution.identifier} · Lead`)!
    .finish({
      outcome: "completed",
      text: "Owner decision required; the blocker is recorded on Linear.",
    });
  await until(() => f.machine.activeCount === 2);
  await f.machine.flush();
  await f.machine.tick(5_000);
  await until(() => f.codex.runs.length === 5);
  assert.deepEqual(scanning(), ["demo", "idle", "other"]);
  assert.equal(f.machine.activeCount, 3);
});

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

test("human review waits again after Todo revisions resume the original Lead with the label retained", async (t) => {
  const task = issue(1, {
    state: "Owner review",
    labels: ["owner-review"],
    prUrls: [pr(1).url],
  });
  const f = await fixture(t, [task]);
  f.config.linear.needs_human_label = "owner-review";
  f.config.repositories[0].states.review = "Owner review";
  f.github.prs.set(1, pr(1));
  const previous = savedJob(task, "execution", {
    threadId: "original-lead",
    workspace: {
      path: f.config.repositories[0].path,
      branch: "symphony/eng-1",
      baseline: "base-sha",
    },
  });
  f.store.save(previous);
  await f.machine.tick(1_000);
  assert.equal(f.codex.runs.length, 0);

  const current = f.linear.issues.get(task.id)!;
  current.state = "Todo";
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 1);
  assert.equal(f.codex.runs[0].input.threadId, previous.threadId);
  assert.equal(current.state, "In Progress");
  assert.deepEqual(current.labels, ["owner-review"]);

  current.state = "Owner review";
  f.codex.runs[0].finish({
    outcome: "completed",
    text: "Revisions ready for owner review.",
  });
  await f.machine.drain();
  await f.machine.tick(5_000);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(
    f.store.jobs().find((job) => job.id === previous.id)!.status,
    "done",
  );
  assert.deepEqual(current.labels, ["owner-review"]);
});

test("no-auto-pickup reserves Todo and interrupted work for the owner until removed", async (t) => {
  const manual = issue(1, { labels: ["no-auto-pickup"] });
  const interrupted = issue(2, {
    state: "In Progress",
    labels: ["no-auto-pickup"],
  });
  const automatic = issue(3);
  const f = await fixture(t, [manual, interrupted, automatic]);
  const workspace = {
    path: join(f.config.repositories[0].worktree_root!, "eng-2"),
    branch: "symphony/eng-2",
    baseline: "base-sha",
  };
  const old = savedJob(interrupted, "execution", {
    status: "running",
    threadId: "owner-held-thread",
    workspace,
    phase: "plan",
  });
  f.store.save(old);
  f.restart();
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  assert.deepEqual(f.github.prepares, [automatic.identifier]);
  assert.equal(f.linear.issues.get(manual.id)!.state, "Todo");
  assert.equal(f.linear.issues.get(interrupted.id)!.state, "In Progress");
  assert.equal(
    f.store.jobs().find((job) => job.id === old.id)!.status,
    "waiting",
  );

  f.linear.issues.get(manual.id)!.labels = [];
  f.linear.issues.get(interrupted.id)!.labels = [];
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 3);
  assert.equal(f.linear.issues.get(manual.id)!.state, "In Progress");
  assert.ok(f.codex.runs.some((run) => run.input.threadId === old.threadId));
  assert.deepEqual(f.github.prepares, [
    automatic.identifier,
    manual.identifier,
  ]);
});

test("the configured no-auto-pickup label also holds review until removed", async (t) => {
  const manual = issue(1, {
    state: "In Review",
    labels: ["manual-only"],
    prUrls: [pr(1).url],
  });
  const automatic = issue(2, { state: "In Review", prUrls: [pr(2).url] });
  const f = await fixture(t, [manual, automatic]);
  f.config.linear.no_auto_pickup_label = "manual-only";
  f.github.prs.set(1, pr(1));
  f.github.prs.set(2, pr(2));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  assert.equal(f.store.jobs()[0].issueId, automatic.id);
  assert.equal(f.linear.issues.get(manual.id)!.state, "In Review");
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "ready_to_merge",
      summary: "Requirements verified.",
      prNumber: 2,
    },
  });
  await f.machine.drain();
  f.linear.issues.get(manual.id)!.labels = [];
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 2);
  assert.equal(
    f.store.jobs().find((job) => job.issueId === manual.id)!.role,
    "review",
  );
});

test("repository execution limits are independent and hot changes preserve active work", async (t) => {
  const f = await fixture(
    t,
    [
      ...[1, 2, 3, 4].map((number) => issue(number)),
      ...[5, 6, 7, 8].map((number) =>
        issue(number, { team: "Other", project: "Other Project" }),
      ),
    ],
    [{ id: "other", team: "Other", project: "Other Project" }],
  );
  const [demo, other] = f.config.repositories;
  demo.concurrency.execution_tickets = 2;
  other.concurrency.execution_tickets = 3;
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 5);
  const running = () =>
    f.store.jobs().filter((job) => job.status === "running");
  assert.equal(f.machine.activeCount, 5);
  assert.equal(running().filter((job) => job.repo === demo.id).length, 2);
  assert.equal(running().filter((job) => job.repo === other.id).length, 3);
  assert.equal(f.linear.issues.get("issue-3")!.state, "Todo");
  assert.equal(f.linear.issues.get("issue-8")!.state, "Todo");

  const originalRuns = [...f.codex.runs];
  const next = structuredClone(f.config);
  next.repositories[0].concurrency.execution_tickets = 1;
  next.repositories[1].concurrency.execution_tickets = 4;
  f.machine.reload(next);
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 6);
  assert.equal(f.machine.activeCount, 6);
  assert.ok(originalRuns.every((run) => !run.input.signal?.aborted));
  assert.equal(running().filter((job) => job.repo === demo.id).length, 2);
  assert.equal(running().filter((job) => job.repo === other.id).length, 4);
  assert.equal(f.linear.issues.get("issue-3")!.state, "Todo");
  assert.equal(f.linear.issues.get("issue-8")!.state, "In Progress");
  assert.equal(
    f.machine.config.repositories[0].concurrency.execution_tickets,
    1,
  );
});

test("repository structural changes still require restart", async (t) => {
  const f = await fixture(t);
  const next = structuredClone(f.config);
  next.repositories[0].branch = "release";
  assert.throws(() => f.machine.reload(next), /require restart/);
  assert.equal(f.machine.config.repositories[0].branch, "master");
});

test("symphony-execute delivers ordinary text while Lead owns Linear state and workpad", async (t) => {
  const task = issue(1, {
    labels: [
      "Lead model/lead-override",
      "Lead reasoning/high",
      "Implementation model/implementation-override",
      "Implementation reasoning/max",
    ],
  });
  const f = await fixture(t, [task]);
  const repo = f.config.repositories[0];
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  const lead = f.codex.runs[0];
  const job = f.store.jobs()[0];
  const workspace = job.workspace!;
  assert.equal(lead.input.title, `${task.identifier} · Lead`);
  assert.equal(lead.input.cwd, repo.path);
  assert.ok(lead.input.writableRoots?.includes(workspace.path));
  assert.equal(lead.input.model, "lead-override");
  assert.equal(lead.input.reasoning, "high");
  assert.equal(lead.input.outputFormat, "text");
  assert.deepEqual(lead.input.config, {
    "agents.enabled": true,
    "agents.default_subagent_model": "implementation-override",
    "agents.default_subagent_reasoning_effort": "max",
  });
  assert.match(lead.input.prompt, /\$symphony-execute/);
  assert.ok(lead.input.prompt.includes(workspace.path));
  assert.ok(lead.input.prompt.includes(workspace.branch));
  assert.equal(job.threadId, "thread-1");
  assert.equal(f.linear.issues.get(task.id)!.state, "In Progress");

  // A PR may exist while the skill is still completing delivery.
  f.github.prs.set(1, pr(1));
  await f.machine.tick(3_000);
  assert.equal(f.machine.activeCount, 1);
  assert.equal(f.linear.issues.get(task.id)!.state, "In Progress");
  const delivery =
    "Verified the change and published the PR; evidence is in the workpad.";
  const latest = f.linear.issues.get(task.id)!;
  latest.state = "In Review";
  latest.prUrls = [pr(1).url];
  f.linear.comments.push({ id: task.id, body: delivery });
  lead.finish({
    outcome: "completed",
    text: delivery,
  });
  await f.machine.drain();
  const delivered = f.store.jobs().find((value) => value.id === job.id)!;
  assert.equal(delivered.status, "done");
  assert.equal(delivered.threadId, job.threadId);
  assert.deepEqual(delivered.workspace, workspace);
  assert.equal(delivered.prNumber, 1);
  assert.equal(delivered.summary, delivery);
  assert.equal(f.machine.activeCount, 0);
  assert.equal(f.linear.issues.get(task.id)!.state, "In Review");
  assert.deepEqual(f.linear.updates, []);
  assert.deepEqual(f.linear.comments, [{ id: task.id, body: delivery }]);
});

test("execution invokes the original skill with headless repository and worktree context", async (t) => {
  const f = await fixture(t, [issue(1)]);
  f.config.codex.workflow = join(
    f.config.repositories[0].path,
    "current-workflow.md",
  );
  f.config.repositories[0].states.review = "Ready for inspection";
  f.config.repositories[0].states.blocked = "Waiting on owner";
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  const input = f.codex.runs[0].input;
  const instructions = `${input.developerInstructions}\n${input.prompt}`;
  assert.match(input.prompt, /\$symphony-execute[\s\S]*ENG-1/);
  assert.match(input.prompt, /headless/i);
  assert.match(input.prompt, /symphony-execute[/\\]SKILL\.md/);
  const skill = input.skills?.find(
    (value) => value.name === "symphony-execute",
  );
  assert.ok(skill);
  assert.ok(input.prompt.includes(skill.path));
  assert.ok(instructions.includes(f.config.codex.workflow));
  assert.ok(input.prompt.includes("Ready for inspection"));
  assert.ok(input.prompt.includes("Waiting on owner"));
  assert.ok(input.prompt.includes(f.config.repositories[0].path));
  assert.ok(input.prompt.includes(f.store.jobs()[0].workspace!.path));
  assert.ok(input.prompt.includes(f.store.jobs()[0].workspace!.branch));
});

test("interrupted execution persists waiting and resumes the same thread and worktree after restart", async (t) => {
  const task = issue(1, { labels: ["Direct"] });
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
  assert.equal(f.codex.runs[1].input.cwd, f.config.repositories[0].path);
  assert.ok(
    f.codex.runs[1].input.writableRoots?.includes(before.workspace!.path),
  );
  assert.deepEqual(f.store.jobs()[0].workspace, before.workspace);
  assert.deepEqual(f.github.prepares, [task.identifier]);
  f.linear.issues.get(task.id)!.state = "In Review";
  f.linear.issues.get(task.id)!.prUrls = [pr(1).url];
  f.codex.runs[1].finish({
    outcome: "completed",
    text: "Verified the resumed work and recorded the PR on Linear.",
  });
  await f.machine.drain();
  assert.equal(f.store.jobs()[0].status, "done");
  assert.equal(f.linear.issues.get(task.id)?.state, "In Review");
});

test("project and global pause preserve sessions, repository flags and worktrees across restart", async (t) => {
  const task = issue(1);
  const otherTask = issue(2, { team: "Other", project: "Other Project" });
  const queued = issue(3);
  const f = await fixture(
    t,
    [task, otherTask, queued],
    [{ id: "other", team: "Other", project: "Other Project" }],
  );
  f.config.repositories[0].concurrency.execution_tickets = 1;
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 2);
  const original = f.store.jobs().find((j) => j.issueId === task.id)!;
  const other = f.store.jobs().find((j) => j.issueId === otherTask.id)!;
  f.machine.setPaused("demo", true);
  await until(() => f.machine.activeCount === 1);
  assert.equal(
    f.store.jobs().find((j) => j.id === original.id)!.status,
    "waiting",
  );
  assert.equal(f.codex.runs[1].input.signal?.aborted, false);
  await f.machine.tick(1_001);
  assert.equal(f.codex.runs.length, 2, "queued work stays unclaimed");
  const paused = f.machine.dashboard().projects.find((p) => p.id === "demo")!;
  assert.equal(paused.paused, true);
  assert.equal(paused.effectivePaused, true);
  assert.equal(paused.activeAgents, 0);

  f.machine.setPaused("all", true);
  await f.machine.drain();
  f.restart();
  await f.machine.tick(1_002);
  assert.equal(f.machine.dashboard().paused, true);
  assert.equal(f.codex.runs.length, 2);
  f.machine.setPaused("all", false);
  await f.machine.tick(1_003);
  await until(() => f.codex.runs.length === 3);
  assert.equal(f.codex.runs[2].input.threadId, other.threadId);
  assert.equal(f.machine.dashboard().projects[0].effectivePaused, true);

  // Reserve the queued ticket so the existing scheduling order leaves room
  // for the interrupted execution when this repository resumes.
  f.linear.issues.get(queued.id)!.labels = ["no-auto-pickup"];
  f.machine.setPaused("demo", false);
  await f.machine.tick(1_004);
  await until(() => f.codex.runs.length === 4);
  assert.equal(f.codex.runs[3].input.threadId, original.threadId);
  assert.deepEqual(
    f.store.jobs().find((j) => j.id === original.id)!.workspace,
    original.workspace,
  );
  assert.deepEqual(f.github.prepares, [task.identifier]);
  assert.deepEqual(f.linear.updates, []);
  assert.deepEqual(f.linear.comments, []);
  assert.equal(f.linear.issues.get(task.id)!.state, "In Progress");
});

for (const role of ["review", "merge", "maintenance"] as const) {
  test(`pause interrupts ${role} and resume reuses its job and thread`, async (t) => {
    const task = issue(1, {
      state: role === "merge" ? "Ready to merge" : "In Review",
      prUrls: [pr(1).url],
    });
    const f = await fixture(t, role === "maintenance" ? [] : [task]);
    f.github.prs.set(1, pr(1));
    f.config.repositories[0].auto_merge = role === "merge";
    f.config.maintenance.enabled = role === "maintenance";
    await f.machine.tick(1_000);
    await until(() => f.codex.runs.length === 1);
    const original = f.store.jobs().find((j) => j.status === "running")!;
    assert.equal(original.role, role);
    f.machine.setPaused("all", true);
    await f.machine.drain();
    const interrupted = f.store.jobs().find((j) => j.id === original.id)!;
    assert.equal(interrupted.status, "waiting");
    if (role === "review") assert.equal(interrupted.fingerprint, undefined);
    await f.machine.tick(1_001);
    assert.equal(f.codex.runs.length, 1);
    f.machine.setPaused("all", false);
    await f.machine.tick(1_002);
    await until(() => f.codex.runs.length === 2);
    assert.equal(f.codex.runs[1].input.threadId, original.threadId);
    assert.equal(f.store.jobs().filter((j) => j.role === role).length, 1);
    assert.deepEqual(
      f.store.jobs().find((j) => j.id === original.id)!.maintenance,
      original.maintenance,
    );
  });
}

test("CLI pause flags interrupt active turns even while outbox synchronization is cooling down", async (t) => {
  const task = issue(1);
  const f = await fixture(t, [task]);
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.store.set("outbox", [
    { id: "pending", issueId: task.id, state: "In Progress" },
  ]);
  const update = f.linear.updateIssue.bind(f.linear);
  f.linear.updateIssue = async () => {
    throw new Error("Linear unavailable");
  };
  await f.machine.tick(2_000);
  assert.equal(f.machine.activeCount, 1);
  f.store.set("pause:all", true);
  await f.machine.tick(2_001);
  await until(() => f.machine.activeCount === 0);
  assert.equal(f.store.jobs()[0].status, "waiting");
  assert.equal(f.machine.dashboard().paused, true);
  f.linear.updateIssue = update;
});

test("pause during a repository read prevents the resulting agent dispatch", async (t) => {
  const f = await fixture(t, [issue(1)]);
  const list = f.linear.listIssues.bind(f.linear);
  f.linear.listIssues = async (filter) => {
    const issues = await list(filter);
    if (filter.state === "Todo") f.machine.setPaused("demo", true);
    return issues;
  };
  await f.machine.tick(1_000);
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.store.jobs().length, 0);
});

test("pause before the final merge command preserves the ready PR", async (t) => {
  const task = issue(1, { state: "Ready to merge", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  f.config.polling.master_ci_seconds = 300;
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: { decision: "done", summary: "Merge ready", issueIds: [task.id] },
  });
  await f.machine.drain();
  const health = f.github.masterHealth.bind(f.github);
  f.github.masterHealth = async () => {
    f.machine.setPaused("demo", true);
    return health();
  };
  await f.machine.tick(2_000);
  assert.deepEqual(f.github.merges, []);
  assert.equal(f.github.prs.get(1)!.state, "OPEN");
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
  assert.equal(f.codex.runs[0].input.cwd, f.config.repositories[0].path);
  assert.ok(f.codex.runs[0].input.writableRoots?.includes(workspace.path));
  assert.deepEqual(f.store.jobs()[0].workspace, workspace);
  assert.deepEqual(f.github.prepares, [task.identifier]);
});

test("a persisted execution resumes its Lead thread and retained external worktree", async (t) => {
  const task = issue(1, { state: "In Progress" });
  const f = await fixture(t, [task]);
  const workspace = {
    path: join(
      f.config.repositories[0].path,
      "..",
      "legacy-state-worktrees",
      "eng-1",
    ),
    branch: "symphony/eng-1",
    baseline: "legacy-base-sha",
  };
  const old = savedJob(task, "execution", {
    status: "running",
    threadId: "existing-lead-thread",
    workerThreadId: "existing-worker-thread",
    workspace,
    phase: "implement",
    handoff: "Implement the approved requirement and run repository checks.",
    workerSummary: "Partial implementation is saved in the issue worktree.",
  });
  f.store.save(old);
  f.restart();
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  const input = f.codex.runs[0].input;
  assert.equal(input.threadId, old.threadId);
  assert.equal(input.title, `${task.identifier} · Lead`);
  assert.equal(input.cwd, f.config.repositories[0].path);
  assert.ok(input.writableRoots?.includes(workspace.path));
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].id, old.id);
  assert.deepEqual(f.store.jobs()[0].workspace, workspace);
  assert.deepEqual(f.github.prepares, []);
});

test("graceful stop allows active execution to finish and does not admit queued tickets", async (t) => {
  const f = await fixture(t, [issue(1), issue(2)]);
  f.config.repositories[0].concurrency.execution_tickets = 1;
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.machine.stop();
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.codex.runs[0].input.signal?.aborted, false);
  f.linear.issues.get("issue-1")!.state = "In Review";
  f.linear.issues.get("issue-1")!.prUrls = [pr(1).url];
  f.codex.runs[0].finish({
    outcome: "completed",
    text: "Ready for review; PR and acceptance evidence are linked on Linear.",
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
  f.store.save(savedJob(task, "execution", { workspace }));
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
  assert.equal(
    f.store.jobs().find((job) => job.role === "execution")!.prNumber,
    1,
  );
  assert.equal(f.linear.issues.get(task.id)?.state, "In Review");
  await f.machine.tick(7_000);
  assert.deepEqual(f.github.cleanups, [1], "completed cleanup is not repeated");
});

test("Linear Ready hands ordinary and human-reviewed work to merge without local approval records", async (t) => {
  for (const labels of [[], ["needs-human"]]) {
    await t.test(
      labels.length ? "human review" : "ordinary review",
      async (t) => {
        const task = issue(1, {
          state: "Ready to merge",
          labels,
          prUrls: [pr(1).url],
        });
        const f = await fixture(t, [task]);
        f.config.repositories[0].auto_merge = true;
        f.github.prs.set(1, pr(1));
        await f.machine.tick(1_000);
        await until(() => f.codex.runs.length === 1);
        assert.equal(f.store.jobs()[0].role, "merge");
        f.codex.runs[0].finish({
          outcome: "completed",
          result: {
            decision: "done",
            summary: "Merge the Ready candidate.",
            issueIds: [task.id],
          },
        });
        await f.machine.drain();
        // Metadata changes do not invalidate the Linear handoff or planned order.
        f.linear.issues.get(task.id)!.updatedAt = "2026-11-07T01:00:00Z";
        f.github.prs.get(1)!.updatedAt = "2026-11-07T01:00:00Z";
        await f.machine.tick(3_000);
        assert.deepEqual(f.github.merges, [1]);
        assert.equal(f.codex.runs.length, 1);
        assert.deepEqual(f.linear.updates, []);
      },
    );
  }
});

test("Ready conflicts return to the original Lead with the completed human gate removed", async (t) => {
  const task = issue(1, {
    state: "Ready to merge",
    labels: ["needs-human", "Feature"],
    prUrls: [pr(1).url],
  });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  const previous = savedJob(task, "execution", {
    threadId: "original-lead",
    workspace: {
      path: f.config.repositories[0].path,
      branch: "symphony/eng-1",
      baseline: "base",
    },
    prNumber: 1,
  });
  f.store.save(previous);
  f.github.prs.set(1, pr(1, { mergeable: "CONFLICTING" }));
  await f.machine.tick(1_000);
  await f.machine.flush();
  assert.equal(f.linear.issues.get(task.id)!.state, "Todo");
  assert.deepEqual(f.linear.issues.get(task.id)!.labels, ["Feature"]);
  assert.match(f.linear.comments[0].body, /Lead must resolve conflicts/);
  assert.deepEqual(f.github.merges, []);
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 1);
  assert.equal(f.codex.runs[0].input.threadId, "original-lead");
});

test("execution observes unfinished and blocked Linear work without marking it delivered", async (t) => {
  for (const scenario of [
    { name: "unfinished", state: "In Progress", labels: [], status: "waiting" },
    { name: "blocked", state: "Blocked", labels: [], status: "blocked" },
    {
      name: "unfinished with retained human review label",
      state: "In Progress",
      labels: ["needs-human"],
      status: "waiting",
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const task = issue(1);
      const f = await fixture(t, [task]);
      await f.machine.tick(1_000);
      await until(() => f.codex.runs.length === 1);
      const original = f.store.jobs()[0];
      const latest = f.linear.issues.get(task.id)!;
      latest.state = scenario.state;
      latest.labels = scenario.labels;
      f.codex.runs[0].finish({
        outcome: "completed",
        text: "Work remains; see the Linear workpad.",
      });
      await f.machine.drain();
      assert.equal(f.store.jobs()[0].status, scenario.status);
      assert.equal(latest.state, scenario.state);
      assert.deepEqual(latest.labels, scenario.labels);
      assert.deepEqual(f.linear.updates, []);
      assert.deepEqual(f.linear.comments, []);
      await f.machine.tick(3_000);
      if (scenario.status === "waiting") {
        await until(() => f.codex.runs.length === 2);
        assert.equal(f.codex.runs[1].input.threadId, original.threadId);
        assert.deepEqual(f.store.jobs()[0].workspace, original.workspace);
      } else {
        assert.equal(f.codex.runs.length, 1);
      }
    });
  }
});

test("an execution runner failure is recorded locally while Lead-owned Linear work is preserved", async (t) => {
  const task = issue(1);
  const f = await fixture(t, [task]);
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "failed",
    error: "Inference failed before a delivery report.",
  });
  await f.machine.drain();
  assert.equal(f.store.jobs()[0].status, "failed");
  assert.match(f.store.jobs()[0].summary!, /Inference failed/);
  assert.equal(f.linear.issues.get(task.id)!.state, "In Progress");
  assert.deepEqual(f.linear.updates, []);
  assert.deepEqual(f.linear.comments, []);
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

test("merge planning shares its repository review capacity while other repositories review independently", async (t) => {
  const candidate = issue(1, { state: "Ready to merge", prUrls: [pr(1).url] });
  const waitingReview = issue(2, { state: "In Review", prUrls: [pr(2).url] });
  const otherPr = pr(3, { url: "https://github.com/demo/other/pull/3" });
  const otherReview = issue(3, {
    team: "Other",
    project: "Other Project",
    state: "In Review",
    prUrls: [otherPr.url],
  });
  const f = await fixture(
    t,
    [candidate, waitingReview, otherReview],
    [{ id: "other", team: "Other", project: "Other Project" }],
  );
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1));
  f.github.prs.set(2, pr(2));
  f.githubFor("other").prs.set(3, otherPr);
  f.store.save(
    savedJob(candidate, "review", {
      prNumber: 1,
      reviewedHead: "head-1",
      fingerprint: `head-1:${pr(1).updatedAt}:${candidate.updatedAt}:context-1`,
    }),
  );
  f.store.set("merge:demo:issue-1", {
    issueId: candidate.id,
    pr: 1,
    head: "head-1",
    summary: "Approved.",
    updatedAt: candidate.updatedAt,
    prUpdatedAt: pr(1).updatedAt,
    reviewFingerprint: "context-1",
  });
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 2);
  assert.equal(f.machine.activeCount, 2);
  assert.deepEqual(
    f.store
      .jobs()
      .filter((job) => job.status === "running")
      .map((job) => ({ repo: job.repo, role: job.role })),
    [
      { repo: "demo", role: "merge" },
      { repo: "other", role: "review" },
    ],
  );
  assert.ok(
    !f.store.jobs().some((job) => job.issueId === waitingReview.id),
    "the planner fills only its own repository's review slot",
  );
});

test("a pending merge planner is not duplicated on later polls when spare review capacity exists", async (t) => {
  const candidate = issue(1, { state: "Ready to merge", prUrls: [pr(1).url] });
  const f = await fixture(t, [candidate]);
  f.config.repositories[0].auto_merge = true;
  f.config.repositories[0].concurrency.reviews = 2;
  f.github.prs.set(1, pr(1));
  f.store.save(
    savedJob(candidate, "review", {
      prNumber: 1,
      reviewedHead: "head-1",
      fingerprint: `head-1:${pr(1).updatedAt}:${candidate.updatedAt}:context-1`,
    }),
  );
  f.store.set("merge:demo:issue-1", {
    issueId: candidate.id,
    pr: 1,
    head: "head-1",
    summary: "Approved.",
    updatedAt: candidate.updatedAt,
    prUpdatedAt: pr(1).updatedAt,
    reviewFingerprint: "context-1",
  });
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.store.jobs().filter((job) => job.role === "merge").length, 1);
  assert.equal(f.codex.runs[0].input.signal?.aborted, false);
});

test("independent PR review promotes Direct delivery to the configured ready state without reviewing its own transition again", async (t) => {
  const task = issue(1, {
    state: "In Review",
    labels: ["Symphony mode/Direct"],
    prUrls: [pr(1).url],
  });
  const f = await fixture(t, [task]);
  f.config.repositories[0].states.ready_to_merge = "Merge queue";
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  assert.match(f.codex.runs[0].input.prompt, /independent Code Reviewer/);
  assert.match(f.codex.runs[0].input.prompt, /First independent PR review/);
  assert.match(f.codex.runs[0].input.prompt, /GitHub PR/);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "ready_to_merge",
      summary: "PR review and delivery evidence passed.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  assert.equal(f.linear.issues.get(task.id)!.state, "Merge queue");
  assert.equal(f.store.jobs()[0].reviewedHead, "head-1");
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 1);
});

test("same-head Lead PR dispositions resume incremental review after findings return Todo", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "needs_changes",
      summary:
        "Resolve findings in https://github.com/demo/repo/pull/1#discussion_r1",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  assert.equal(f.linear.issues.get(task.id)!.state, "Todo");
  f.github.reviewFingerprints.set(1, "lead-rejected-with-evidence");
  f.linear.issues.get(task.id)!.state = "In Review";
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 2);
  assert.equal(f.codex.runs[1].input.threadId, "thread-1");
  assert.match(
    f.codex.runs[1].input.prompt,
    /Incremental re-review.*Last completed review head: head-1/,
  );
  assert.match(f.codex.runs[1].input.prompt, /If the head is unchanged/);
  assert.match(f.codex.runs[1].input.prompt, /reasoned Lead disposition/);
  f.codex.runs[1].finish({
    outcome: "completed",
    result: {
      decision: "ready_to_merge",
      summary: "Lead disposition recorded on PR; required evidence passed.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  assert.equal(f.linear.issues.get(task.id)!.state, "Ready to merge");
});

test("pending PR CI waits in Review without dispatching an agent or marking the ticket Blocked", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.github.prs.set(1, pr(1, { checks: "pending" }));
  await f.machine.tick(1_000);
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.linear.issues.get(task.id)!.state, "In Review");
  assert.deepEqual(f.linear.updates, []);
  f.github.prs.get(1)!.checks = "success";
  await f.machine.tick(5_000);
  await until(() => f.codex.runs.length === 1);
});

test("required human review holds In Review and a reviewer failure does not declare an external blocker", async (t) => {
  for (const human of [true, false]) {
    await t.test(human ? "human review" : "technical failure", async (t) => {
      const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
      const f = await fixture(t, [task]);
      f.github.prs.set(1, pr(1));
      await f.machine.tick(1_000);
      await until(() => f.codex.runs.length === 1);
      f.codex.runs[0].finish(
        human
          ? {
              outcome: "completed",
              result: {
                decision: "needs_human",
                summary:
                  "Lead requires owner review of permission changes; see PR #1.",
                prNumber: 1,
              },
            }
          : { outcome: "failed", error: "GitHub tool unavailable" },
      );
      await f.machine.drain();
      assert.equal(f.linear.issues.get(task.id)!.state, "In Review");
      assert.equal(
        f.linear.issues.get(task.id)!.labels.includes("needs-human"),
        human,
      );
      await f.machine.tick(3_000);
      assert.equal(f.codex.runs.length, 1);
    });
  }
});

test("an agent's existing Ready handoff is respected after review completion", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  await f.linear.updateIssue(task.id, { state: "Ready to merge" });
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "ready_to_merge",
      summary: "Reviewed head-1.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  await f.machine.tick(1_861_000);
  await until(() => f.codex.runs.length === 2);
  assert.equal(f.store.jobs().filter((j) => j.role === "review").length, 1);
  assert.equal(
    f.store.jobs().find((j) => j.status === "running")!.role,
    "merge",
  );
  assert.equal(f.linear.issues.get(task.id)!.state, "Ready to merge");
});

test("a PR head changed during merge planning returns to Lead verification", async (t) => {
  const task = issue(1, { state: "Ready to merge", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.github.prs.get(1)!.head = "head-2";
  f.github.prs.get(1)!.checks = "pending";
  f.codex.runs[0].finish({
    outcome: "completed",
    result: { decision: "done", summary: "Merge first.", issueIds: [task.id] },
  });
  await f.machine.drain();
  await f.machine.tick(3_000);
  await f.machine.flush();
  assert.deepEqual(f.github.merges, []);
  assert.equal(f.codex.runs.length, 1);
  assert.equal(f.linear.issues.get(task.id)!.state, "Todo");
  assert.match(f.linear.comments[0].body, /head changed after merge planning/);
});

test("resolved external review blockers resume on returning to In Review", async (t) => {
  const task = issue(1, { state: "In Review", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.github.prs.set(1, pr(1));
  await f.machine.tick(1_000);
  await until(() => f.codex.runs.length === 1);
  f.codex.runs[0].finish({
    outcome: "completed",
    result: {
      decision: "blocked",
      summary: "External evidence unavailable.",
      prNumber: 1,
    },
  });
  await f.machine.drain();
  assert.equal(f.linear.issues.get(task.id)!.state, "Blocked");
  await f.linear.comment(
    task.id,
    "External prerequisite restored; resume review.",
  );
  await f.linear.updateIssue(task.id, { state: "In Review" });
  await f.machine.tick(3_000);
  await until(() => f.codex.runs.length === 2);
  assert.equal(f.codex.runs[1].input.threadId, "thread-1");
});

test("Ready waits for current CI and honors no-auto-pickup", async (t) => {
  const task = issue(1, { state: "Ready to merge", prUrls: [pr(1).url] });
  const f = await fixture(t, [task]);
  f.config.repositories[0].auto_merge = true;
  f.github.prs.set(1, pr(1, { checks: "pending" }));
  await f.machine.tick(1_000);
  await f.machine.tick(3_000);
  assert.equal(f.codex.runs.length, 0);
  assert.deepEqual(f.linear.updates, []);
  f.github.prs.get(1)!.checks = "success";
  f.linear.issues.get(task.id)!.labels = ["needs-human", "no-auto-pickup"];
  await f.machine.tick(5_000);
  assert.equal(f.codex.runs.length, 0);
  assert.deepEqual(f.github.merges, []);
});

test("a no-PR CI incident already completed in Linear is observed locally", async (t) => {
  const incident = issue(70, { title: "[CI repair] demo target" });
  const f = await fixture(t, [incident]);
  f.store.set("repair:demo", incident.id);
  await f.machine.tick(1000);
  await until(() => f.codex.runs.length === 1);
  // The owner may resolve an incident while the skill is investigating it.
  f.linear.issues.get(incident.id)!.state = "Done";
  f.codex.runs[0].finish({
    outcome: "completed",
    text: "The transient job retry passed on current target; the evidence and completion are recorded on Linear.",
  });
  await until(() => f.machine.activeCount === 0);
  await f.machine.flush();
  assert.equal(f.linear.issues.get(incident.id)!.state, "Done");
  assert.equal(f.store.jobs()[0].status, "done");
  assert.equal(f.store.jobs()[0].prNumber, undefined);
  assert.equal(f.store.get(`no_pr:${incident.id}`), undefined);
  assert.deepEqual(f.linear.updates, []);
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

test("repository poll failures back off without dashboard bypass, survive reload, and reset after success", async (t) => {
  const f = await fixture(t);
  f.config.polling.linear_seconds = 60;
  f.config.polling.master_ci_seconds = 60;
  let attempts = 0;
  let unavailable = true;
  let linearReads = 0;
  const list = f.linear.listIssues.bind(f.linear);
  f.linear.listIssues = async (filter) => {
    linearReads++;
    return list(filter);
  };
  f.github.masterHealth = async () => {
    attempts++;
    if (unavailable) throw new Error("upstream unavailable");
    return { sha: "master-sha", status: "success" };
  };
  let now = 1_000;
  for (let failure = 1; failure <= 5; failure++) {
    await f.machine.tick(now);
    assert.equal(attempts, failure);
    assert.equal(
      linearReads,
      0,
      "dashboard must respect the repository cooldown",
    );
    const details = f.logs.findLast((log) => log.event === "poll_error")!
      .details as { failures: number; retryAt: string; retryInMs: number };
    assert.equal(details.failures, failure);
    const minimum = Math.min(60_000 * 2 ** failure, 900_000);
    assert.ok(
      details.retryInMs >= minimum &&
        details.retryInMs <= Math.min(minimum * 2, 900_000),
    );
    now = Date.parse(details.retryAt);
    if (failure === 1) f.machine.reload(structuredClone(f.config));
    await f.machine.tick(now - 1);
    assert.equal(attempts, failure);
  }
  unavailable = false;
  await f.machine.tick(now);
  assert.equal(attempts, 6);
  assert.ok(linearReads > 0);
  unavailable = true;
  await f.machine.tick(now + 60_000);
  const reset = f.logs.findLast((log) => log.event === "poll_error")!
    .details as { failures: number };
  assert.equal(reset.failures, 1);
});

test("failed outbox synchronization backs off instead of writing on every runner tick", async (t) => {
  const task = issue(1, { labels: ["no-auto-pickup"] });
  const f = await fixture(t, [task]);
  f.store.set("outbox", [
    { id: "change-1", issueId: task.id, state: "Blocked" },
  ]);
  let attempts = 0;
  const update = f.linear.updateIssue.bind(f.linear);
  f.linear.updateIssue = async (id, patch) => {
    attempts++;
    if (attempts <= 2) throw new Error("Linear temporarily unavailable: 502");
    return update(id, patch);
  };
  let now = 1_000;
  for (let failure = 1; failure <= 2; failure++) {
    await f.machine.tick(now);
    const details = f.logs.findLast((log) => log.event === "sync_error")!
      .details as { failures: number; retryAt: string };
    assert.equal(details.failures, failure);
    now = Date.parse(details.retryAt);
    await f.machine.tick(now - 1);
    assert.equal(attempts, failure);
    assert.equal(f.store.get<unknown[]>("outbox")!.length, 1);
  }
  await f.machine.tick(now);
  assert.equal(attempts, 3);
  assert.deepEqual(f.store.get("outbox"), []);
  assert.equal(f.linear.issues.get(task.id)!.state, "Blocked");
});
