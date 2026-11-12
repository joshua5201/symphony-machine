import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { Machine } from "../src/machine.js";
import { Store, type Job } from "../src/store.js";
import type { LinearIssue } from "../src/linear.js";
import type { PrInfo } from "../src/github.js";

const issueTime = "2026-11-07T00:00:00.000Z";
const prTime = "2026-11-07T00:01:00.000Z";
type HealthStatus = "success" | "failure" | "pending" | "unknown";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "symphony-merge-test-"));
  const file = join(dir, "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      data_dir: dir,
      repositories: [
        {
          id: "app",
          path: dir,
          github: "owner/app",
          branch: "master",
          team: "ENG",
          project: "App",
        },
      ],
    }),
  );
  const config = loadConfig(file);
  const repo = config.repositories[0];
  const store = new Store(join(dir, "state.sqlite"));
  const issues = new Map<string, LinearIssue>();
  const prs = new Map<number, PrInfo>();
  const merges: Array<{ number: number; head: string }> = [];
  const cleanups: Array<{ workspace: Job["workspace"]; number: number }> = [];
  const linearWrites: Array<{
    issueId: string;
    patch?: unknown;
    comment?: string;
  }> = [];
  const plans: Array<any> = [];
  const state = {
    now: 1_000_000,
    targetSha: "target-head",
    targetHealth: "success" as HealthStatus,
    targetReads: 0,
    reviewFingerprint: "context-1",
    plannedOrder: [] as string[],
    runner: async (input: any): Promise<any> => ({
      outcome: "completed",
      result: {
        decision: "done",
        summary: "Approved merge order",
        issueIds: state.plannedOrder.filter((id) =>
          input.prompt.includes(JSON.stringify(id)),
        ),
      },
    }),
  };
  const linear = {
    async getIssue(id: string) {
      assert(issues.has(id), `Unknown issue ${id}`);
      return structuredClone(issues.get(id)!);
    },
    async listIssues(filter: { state?: string }) {
      return [...issues.values()]
        .filter((value) => !filter.state || value.state === filter.state)
        .map((value) => structuredClone(value));
    },
    async updateIssue(
      issueId: string,
      patch: { state?: string; labels?: string[] },
    ) {
      linearWrites.push({ issueId, patch });
      const issue = issues.get(issueId)!;
      if (patch.state) issue.state = patch.state;
      if (patch.labels) issue.labels = patch.labels;
    },
    async comment(issueId: string, comment: string) {
      linearWrites.push({ issueId, comment });
    },
  };
  const github = {
    async pr(number: number) {
      assert(prs.has(number), `Unknown PR ${number}`);
      return structuredClone(prs.get(number)!);
    },
    async reviewContext(number: number) {
      return {
        fingerprint:
          number === 1 ? state.reviewFingerprint : `context-${number}`,
        reviews: [],
        comments: [],
        inlineComments: [],
      };
    },
    async masterHealth() {
      state.targetReads++;
      return { sha: state.targetSha, status: state.targetHealth };
    },
    async merge(number: number, head: string) {
      merges.push({ number, head });
      prs.get(number)!.state = "MERGED";
      state.targetSha = `target-after-${number}`;
      state.targetHealth = "pending";
    },
    async cleanup(workspace: Job["workspace"], number: number) {
      cleanups.push({ workspace, number });
    },
  };
  function createMachine(currentConfig = config) {
    return new Machine(
      currentConfig,
      store,
      linear as any,
      {
        run: (input: unknown) => {
          plans.push(input);
          return state.runner(input);
        },
      } as any,
      () => {},
      () => github as any,
    );
  }
  let machine = createMachine();
  store.set(`health:${repo.id}`, {
    sha: state.targetSha,
    status: state.targetHealth,
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function candidate(id = "one", number = 1) {
    const issue: LinearIssue = {
      id,
      identifier: `ENG-${number}`,
      title: `Approved ${id}`,
      description: "Accepted requirements",
      state: repo.states.ready_to_merge,
      url: `https://linear.app/example/issue/ENG-${number}`,
      labels: [],
      updatedAt: issueTime,
      blockedBy: [],
      prUrls: [`https://github.com/owner/app/pull/${number}`],
    };
    const pr: PrInfo = {
      number,
      url: issue.prUrls[0],
      head: `reviewed-head-${number}`,
      base: repo.branch,
      branch: `symphony/eng-${number}`,
      state: "OPEN",
      draft: false,
      mergeable: "MERGEABLE",
      checks: "success",
      reviewDecision: "APPROVED",
      updatedAt: prTime,
    };
    const execution: Job = {
      id: `execution-${id}`,
      repo: repo.id,
      issueId: id,
      identifier: issue.identifier,
      role: "execution",
      status: "done",
      prNumber: number,
      startedAt: issueTime,
      updatedAt: issueTime,
      workspace: {
        path: join(dir, `eng-${number}`),
        branch: pr.branch,
        baseline: "baseline",
      },
    };
    const review: Job = {
      id: `review-${id}`,
      repo: repo.id,
      issueId: id,
      identifier: issue.identifier,
      role: "review",
      status: "done",
      prNumber: number,
      head: pr.head,
      reviewedHead: pr.head,
      fingerprint: `${pr.head}:${pr.updatedAt}:${issue.updatedAt}:context-${number}`,
      startedAt: issueTime,
      updatedAt: issueTime,
    };
    issues.set(id, issue);
    prs.set(number, pr);
    store.save(execution);
    store.save(review);
    state.plannedOrder.push(id);
    store.set(`health:${repo.id}`, {
      sha: state.targetSha,
      status: state.targetHealth,
    });
    return { issue, pr, execution, review };
  }
  const merge = () => (machine as any).merge(repo, state.now) as Promise<void>;
  const health = () => (machine as any).health(repo) as Promise<void>;
  const mergedNumbers = () => merges.map((value) => value.number);
  async function plan() {
    await merge();
    await machine.drain();
  }
  return {
    get machine() {
      return machine;
    },
    repo,
    store,
    state,
    issues,
    prs,
    merges,
    mergedNumbers,
    cleanups,
    linearWrites,
    plans,
    candidate,
    merge,
    health,
    plan,
    restart() {
      machine = createMachine(machine.config);
      machine.recover();
    },
  };
}

test("failed target CI pauses ordinary merges and permits a checked CI repair candidate", async (t) => {
  const f = setup(t);
  f.state.targetHealth = "failure";
  const ordinary = f.candidate("ordinary", 1);
  const repair = f.candidate("repair", 2);
  f.store.set(`repair:${f.repo.id}`, repair.issue.id);
  repair.pr.checks = "pending";
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, []);
  assert.equal(
    f.state.targetReads,
    0,
    "pending repair checks must gate the merge",
  );
  repair.pr.checks = "success";
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, [
    { number: repair.pr.number, head: repair.pr.head },
  ]);
  assert.equal(
    f.state.targetReads,
    1,
    "target CI must be rechecked immediately before merging",
  );
  assert.equal(ordinary.pr.state, "OPEN");
});

test("no-auto-pickup excludes approved work from merge planning and a cached merge plan", async (t) => {
  const f = setup(t);
  const { issue } = f.candidate();
  issue.labels = ["no-auto-pickup"];
  await f.plan();
  assert.equal(f.store.jobs().filter((job) => job.role === "merge").length, 0);
  assert.deepEqual(f.merges, []);

  issue.labels = [];
  f.state.now += 30 * 60_000;
  await f.plan();
  assert.equal(f.store.jobs().filter((job) => job.role === "merge").length, 1);
  issue.labels = ["no-auto-pickup"];
  await f.merge();
  assert.deepEqual(f.merges, []);
  assert.deepEqual(f.linearWrites, []);
});

test("a newly failed target CI check prevents an ordinary merge", async (t) => {
  const f = setup(t);
  f.candidate();
  await f.plan();
  f.state.targetHealth = "failure";
  await f.merge();
  assert.equal(f.state.targetReads, 1);
  assert.deepEqual(f.merges, []);
  assert.equal(
    f.store.get<{ status: string }>(`health:${f.repo.id}`)!.status,
    "failure",
  );
});

test("a verified merge preserves Linear state while managed cleanup proceeds", async (t) => {
  const f = setup(t);
  const { issue, pr, execution } = f.candidate();
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, [{ number: pr.number, head: pr.head }]);
  assert.equal(f.store.get(`cleanup:${execution.id}`), true);
  assert.deepEqual(f.cleanups, [], "cleanup follows the confirmed merge");
  assert.equal(
    f.store.get<{ status: string }>(`health:${f.repo.id}`)!.status,
    "pending",
  );
  await f.machine.flush();
  assert.equal(issue.state, f.repo.states.ready_to_merge);
  await (f.machine as any).cleanup(f.repo);
  assert.deepEqual(f.cleanups, [
    { workspace: execution.workspace, number: pr.number },
  ]);
  assert.equal(f.store.get(`cleaned:${execution.id}`), true);
});

test("a PR merged into a different target retains its workspace and Linear review state", async (t) => {
  const f = setup(t);
  const { issue, pr, execution } = f.candidate();
  pr.state = "MERGED";
  pr.base = "release";
  await (f.machine as any).cleanup(f.repo);
  await f.machine.flush();
  assert.deepEqual(f.cleanups, []);
  assert.equal(issue.state, f.repo.states.ready_to_merge);
  assert.deepEqual(
    f.store.jobs().find((job) => job.id === execution.id)!.workspace,
    execution.workspace,
  );
  assert.equal(f.store.get(`cleanup:${execution.id}`), undefined);
});

test("an interrupted review remains In Review and is not a merge candidate", async (t) => {
  const f = setup(t);
  const { issue, review } = f.candidate();
  issue.state = f.repo.states.review;
  review.fingerprint = "old-review";
  f.store.save(review);
  f.state.runner = async () => ({ outcome: "interrupted" });
  await (f.machine as any).reviews(f.repo);
  await f.machine.drain();
  await f.merge();
  assert.deepEqual(f.merges, []);
});

test("fixed merge groups settle each target and skip busy admission deadlines", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();
  assert.equal(f.plans.length, 1);
  assert.deepEqual(f.merges, [], "planning is required before the first merge");

  f.state.now++;
  f.candidate("late", 3);
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);
  const mergedTarget = f.state.targetSha;

  f.state.now = start + 10 * 60_000;
  f.state.targetSha = "target-head";
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  assert.deepEqual(
    f.mergedNumbers(),
    [1],
    "the old target's passing CI cannot settle the merged target",
  );

  f.state.now = start + 29 * 60_000;
  f.state.targetSha = mergedTarget;
  f.state.targetHealth = "pending";
  await f.health();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);

  f.state.now = start + 30 * 60_000;
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  f.state.now = start + 35 * 60_000 - 1;
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);
  f.state.now++;
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 2]);
  assert.equal(
    f.plans.length,
    1,
    "new Ready work and merged members do not replan the fixed group",
  );

  f.state.now = start + 59 * 60_000;
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  f.state.now = start + 60 * 60_000;
  await f.merge();
  f.state.now = start + 64 * 60_000;
  await f.merge();
  f.state.now = start + 90 * 60_000 - 1;
  await f.plan();
  assert.equal(
    f.plans.length,
    1,
    "the final merge's cooldown keeps the group active across the second deadline",
  );

  f.state.now++;
  await f.plan();
  assert.equal(
    f.plans.length,
    2,
    "the next future deadline admits the waiting singleton",
  );
  assert.match(f.plans[1].prompt, /"issueId":"late"/);
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 2, 3]);
});

test("an empty startup admission advances the schedule before new Ready work arrives", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  await f.plan();
  f.candidate();
  f.state.now = start + 30 * 60_000 - 1;
  await f.plan();
  assert.equal(f.plans.length, 0);
  f.state.now++;
  await f.plan();
  assert.equal(f.plans.length, 1);
});

test("a selected candidate's pending checks preserve the planned merge order", async (t) => {
  const f = setup(t);
  const first = f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();
  first.pr.checks = "pending";
  await f.merge();
  assert.deepEqual(f.merges, []);
  first.pr.checks = "success";
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);
  assert.equal(f.plans.length, 1);
});

test("a newly advanced target restarts cooldown when the live expiry check observes it", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();
  await f.merge();
  f.state.now = start + 60_000;
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();

  f.state.now = start + 6 * 60_000;
  f.state.targetSha = "external-target-advance";
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);
  f.state.now = start + 11 * 60_000;
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 2]);
  assert.equal(f.plans.length, 1);
});

for (const outcome of ["interrupted", "failed"] as const) {
  test(`${outcome} merge planning recovers the admitted group and completed planning survives restart`, async (t) => {
    const f = setup(t);
    const start = f.state.now;
    f.candidate("first", 1);
    const complete = f.state.runner;
    f.state.runner = async (input: any) => {
      input.onThread("planning-thread");
      return { outcome, error: "Planner interrupted before its decision" };
    };
    await f.plan();
    assert.equal(f.plans.length, 1);
    assert.deepEqual(f.merges, []);

    f.candidate("late", 2);
    f.state.runner = complete;
    f.restart();
    await f.plan();
    assert.equal(f.plans.length, 2);
    assert.match(f.plans[1].prompt, /"issueId":"first"/);
    assert.doesNotMatch(f.plans[1].prompt, /"issueId":"late"/);
    if (outcome === "interrupted")
      assert.equal(f.plans[1].threadId, "planning-thread");

    f.restart();
    await f.merge();
    assert.deepEqual(f.mergedNumbers(), [1]);
    assert.equal(
      f.plans.length,
      2,
      "completed planning is reused after restart",
    );
    f.state.now = start + 60_000;
    f.state.targetHealth = "success";
    await f.health();
    await f.merge();
    f.restart();
    f.state.now = start + 6 * 60_000;
    await f.merge();
    await f.merge();
    assert.equal(
      f.plans.length,
      2,
      "settling and the admission deadline survive restart",
    );
    f.state.now = start + 30 * 60_000;
    await f.plan();
    assert.equal(f.plans.length, 3);
    await f.merge();
    assert.deepEqual(f.mergedNumbers(), [1, 2]);
  });
}

test("restart recovers a confirmed merge after Linear becomes Done and settles it only once", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  const first = f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();

  // GitHub and Linear completed the merge before the runner persisted its result.
  first.pr.state = "MERGED";
  first.issue.state = f.repo.states.done;
  f.state.targetSha = "externally-confirmed-merge";
  f.state.targetHealth = "pending";
  await f.health();
  f.restart();
  await f.merge();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), []);

  f.state.now = start + 60_000;
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  assert.deepEqual(
    f.mergedNumbers(),
    [],
    "the recovered merge still requires its post-CI cooldown",
  );
  f.restart();
  f.state.now = start + 6 * 60_000;
  await f.merge();
  assert.deepEqual(
    f.mergedNumbers(),
    [2],
    "the consumed merged member does not restart observation",
  );
  assert.equal(f.plans.length, 1);
});

test("zero cooldown still refreshes target CI when recovering an unrecorded merge", async (t) => {
  const f = setup(t);
  f.machine.config.merge.cooldown_minutes = 0;
  const first = f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();
  first.pr.state = "MERGED";
  first.issue.state = f.repo.states.done;
  f.state.targetSha = "recovered-target";
  f.state.targetHealth = "pending";
  f.restart();
  await f.merge();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), []);
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [2]);
});

test("reloaded merge intervals move the deadline and cooldown uses elapsed healthy time", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  await f.plan();
  f.candidate("first", 1);
  f.candidate("second", 2);
  f.state.now = start + 10 * 60_000;
  const next = structuredClone(f.machine.config);
  next.merge.group_interval_minutes = 60;
  f.machine.reload(next);
  f.state.now = start + 30 * 60_000;
  await f.plan();
  assert.equal(
    f.plans.length,
    0,
    "reload replaces the previous interval's deadline",
  );
  f.state.now = start + 60 * 60_000;
  await f.plan();
  assert.equal(f.plans.length, 1);
  await f.merge();

  f.state.now = start + 61 * 60_000;
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  f.state.now = start + 63 * 60_000;
  const slower = structuredClone(f.machine.config);
  slower.merge.cooldown_minutes = 10;
  f.machine.reload(slower);
  f.state.now = start + 66 * 60_000;
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);
  f.state.now = start + 71 * 60_000;
  await f.merge();
  assert.deepEqual(
    f.mergedNumbers(),
    [1, 2],
    "reload keeps the original healthy-since time",
  );
});

test("a consumed normal-group repair can be planned again after Lead returns it Ready", async (t) => {
  const f = setup(t);
  f.candidate("ordinary", 1);
  const repair = f.candidate("repair", 2);
  f.store.set(`repair:${f.repo.id}`, repair.issue.id);
  await f.plan();

  f.state.targetHealth = "failure";
  repair.issue.title = `[CI repair] ${f.repo.id} ${f.state.targetSha.slice(0, 12)}`;
  await f.health();
  repair.pr.head = "repair-head-after-planning";
  await f.merge();
  await f.machine.flush();
  assert.equal(repair.issue.state, f.repo.states.todo);
  assert.deepEqual(f.mergedNumbers(), []);

  repair.issue.state = f.repo.states.ready_to_merge;
  f.state.now += 60_000;
  await f.plan();
  assert.equal(
    f.plans.length,
    2,
    "consumed membership does not prevent checked repair re-admission",
  );
  assert.match(f.plans[1].prompt, /"head":"repair-head-after-planning"/);
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [2]);
});

test("a separately planned CI repair can unblock a failed target inside an active normal group", async (t) => {
  const f = setup(t);
  const start = f.state.now;
  f.candidate("first", 1);
  f.candidate("second", 2);
  await f.plan();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1]);

  f.state.now = start + 60_000;
  f.state.targetHealth = "failure";
  const repair = f.candidate("repair", 3);
  repair.issue.title = `[CI repair] ${f.repo.id} ${f.state.targetSha.slice(0, 12)}`;
  repair.pr.checks = "pending";
  await f.health();
  await f.plan();
  assert.equal(
    f.plans.length,
    1,
    "repair PR checks still gate planning and merging",
  );
  assert.deepEqual(f.mergedNumbers(), [1]);
  repair.pr.checks = "success";
  await f.plan();
  assert.equal(
    f.plans.length,
    2,
    "the repair is independently planned while the normal group waits",
  );
  assert.match(f.plans[1].prompt, /"issueId":"repair"/);
  assert.doesNotMatch(f.plans[1].prompt, /"issueId":"second"/);
  repair.pr.head = "repair-head-after-emergency-planning";
  await f.merge();
  await f.machine.flush();
  assert.equal(repair.issue.state, f.repo.states.todo);
  assert.deepEqual(f.mergedNumbers(), [1]);
  repair.issue.state = f.repo.states.ready_to_merge;
  await f.plan();
  assert.equal(
    f.plans.length,
    3,
    "a dropped repair group does not monopolize the failed-target recovery path",
  );
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 3]);

  f.state.now = start + 2 * 60_000;
  await f.health();
  await f.merge();
  assert.deepEqual(
    f.mergedNumbers(),
    [1, 3],
    "normal work still waits for the repaired target's CI",
  );
  f.state.targetHealth = "success";
  await f.health();
  await f.merge();
  f.state.now = start + 7 * 60_000 - 1;
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 3]);
  f.state.now++;
  await f.merge();
  await f.merge();
  assert.deepEqual(f.mergedNumbers(), [1, 3, 2]);
  assert.equal(
    f.plans.length,
    3,
    "the original normal plan resumes without replanning",
  );
});
