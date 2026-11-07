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
  const updates: number[] = [];
  const cleanups: Array<{ workspace: Job["workspace"]; number: number }> = [];
  const linearWrites: Array<{
    issueId: string;
    patch?: unknown;
    comment?: string;
  }> = [];
  const state = {
    targetHealth: "success" as HealthStatus,
    targetReads: 0,
    branchUpdate: "current" as "current" | "updated" | "conflict",
    plannedOrder: [] as string[],
    runner: async (_input: unknown): Promise<any> => ({
      outcome: "completed",
      result: {
        decision: "done",
        summary: "Approved merge order",
        issueIds: state.plannedOrder,
      },
    }),
  };
  const linear = {
    async getIssue(id: string) {
      assert(issues.has(id), `Unknown issue ${id}`);
      return structuredClone(issues.get(id)!);
    },
    async listIssues() {
      return [...issues.values()].map((value) => structuredClone(value));
    },
    async updateIssue(
      issueId: string,
      patch: { state?: string; labels?: string[] },
    ) {
      linearWrites.push({ issueId, patch });
      Object.assign(issues.get(issueId)!, patch);
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
    async updateBranch(number: number) {
      updates.push(number);
      if (state.branchUpdate === "updated")
        prs.get(number)!.head = "head-after-base-update";
      return state.branchUpdate;
    },
    async masterHealth() {
      state.targetReads++;
      return { sha: "target-head", status: state.targetHealth };
    },
    async merge(number: number, head: string) {
      merges.push({ number, head });
      prs.get(number)!.state = "MERGED";
    },
    async cleanup(workspace: Job["workspace"], number: number) {
      cleanups.push({ workspace, number });
    },
  };
  const machine = new Machine(
    config,
    store,
    linear as any,
    { run: (input: unknown) => state.runner(input) } as any,
    () => {},
    () => github as any,
  );
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
      state: repo.states.review,
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
      fingerprint: `${pr.head}:${pr.updatedAt}:${issue.updatedAt}`,
      startedAt: issueTime,
      updatedAt: issueTime,
    };
    issues.set(id, issue);
    prs.set(number, pr);
    store.save(execution);
    store.save(review);
    store.set(`merge:${repo.id}:${id}`, {
      issueId: id,
      pr: number,
      head: pr.head,
      summary: "Requirements verified",
      updatedAt: issue.updatedAt,
      prUpdatedAt: pr.updatedAt,
    });
    state.plannedOrder.push(id);
    store.set(`health:${repo.id}`, {
      sha: "target-head",
      status: state.targetHealth,
    });
    return { issue, pr, execution, review };
  }
  const merge = () => (machine as any).merge(repo) as Promise<void>;
  async function plan() {
    await merge();
    await machine.drain();
  }
  return {
    machine,
    repo,
    store,
    state,
    issues,
    prs,
    merges,
    updates,
    cleanups,
    linearWrites,
    candidate,
    merge,
    plan,
  };
}

test("stale head, PR review metadata, or Linear review snapshot cannot authorize merging", async (t) => {
  for (const change of ["head", "pr-metadata", "issue-metadata"] as const)
    await t.test(change, async (t) => {
      const f = setup(t);
      const { issue, pr, review } = f.candidate();
      await f.plan();
      if (change === "head") pr.head = "new-unreviewed-head";
      else if (change === "pr-metadata")
        pr.updatedAt = "2026-11-07T00:02:00.000Z";
      else issue.updatedAt = "2026-11-07T00:02:00.000Z";
      await f.merge();
      assert.deepEqual(f.merges, []);
      assert.deepEqual(
        f.updates,
        [],
        "stale approvals must be rejected before branch mutation",
      );
      assert.equal(f.store.get(`merge:${f.repo.id}:${issue.id}`), null);
      assert.equal(
        f.store.jobs().find((job) => job.id === review.id)!.fingerprint,
        undefined,
      );
    });
});

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
  assert.deepEqual(
    f.updates,
    [repair.pr.number],
    "ordinary work stays paused even when the planner puts it first",
  );
  assert.equal(
    f.state.targetReads,
    0,
    "pending repair checks must gate the merge",
  );
  repair.pr.checks = "success";
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

test("a branch conflict queues Todo with an explanation and invalidates its merge approval", async (t) => {
  const f = setup(t);
  const { issue } = f.candidate();
  f.state.branchUpdate = "conflict";
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, []);
  assert.equal(f.store.get(`merge:${f.repo.id}:${issue.id}`), null);
  const outbox =
    f.store.get<Array<{ issueId: string; state: string; comment: string }>>(
      "outbox",
    )!;
  assert.equal(outbox[0].issueId, issue.id);
  assert.equal(outbox[0].state, f.repo.states.todo);
  assert.match(outbox[0].comment, /conflicts with master/);
  await f.machine.flush();
  assert.equal(issue.state, f.repo.states.todo);
});

test("updating a PR branch invalidates its review before any merge", async (t) => {
  const f = setup(t);
  const { issue, review } = f.candidate();
  f.state.branchUpdate = "updated";
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, []);
  assert.equal(f.store.get(`merge:${f.repo.id}:${issue.id}`), null);
  assert.equal(
    f.store.jobs().find((job) => job.id === review.id)!.fingerprint,
    undefined,
  );
  assert.equal(f.state.targetReads, 0);
});

test("a successful merge queues Done, persists cleanup work, and runs managed cleanup", async (t) => {
  const f = setup(t);
  const { issue, pr, execution } = f.candidate();
  await f.plan();
  await f.merge();
  assert.deepEqual(f.merges, [{ number: pr.number, head: pr.head }]);
  assert.equal(f.store.get(`merge:${f.repo.id}:${issue.id}`), null);
  assert.equal(f.store.get(`cleanup:${execution.id}`), true);
  assert.deepEqual(f.cleanups, [], "cleanup follows the confirmed merge");
  const outbox =
    f.store.get<Array<{ issueId: string; state: string; comment: string }>>(
      "outbox",
    )!;
  assert.equal(outbox[0].issueId, issue.id);
  assert.equal(outbox[0].state, f.repo.states.done);
  assert.match(
    outbox[0].comment,
    /Merged https:\/\/github.com\/owner\/app\/pull\/1/,
  );
  assert.equal(
    f.store.get<{ status: string }>(`health:${f.repo.id}`)!.status,
    "pending",
  );
  await f.machine.flush();
  assert.equal(issue.state, f.repo.states.done);
  await (f.machine as any).cleanup(f.repo);
  assert.deepEqual(f.cleanups, [
    { workspace: execution.workspace, number: pr.number },
  ]);
  assert.equal(f.store.get(`cleaned:${execution.id}`), true);
});

test("an interrupted new review cannot leave a previous merge approval usable", async (t) => {
  const f = setup(t);
  const { issue, review } = f.candidate();
  review.fingerprint = "old-review";
  f.store.save(review);
  f.state.runner = async () => ({ outcome: "interrupted" });
  await (f.machine as any).reviews(f.repo);
  await f.machine.drain();
  assert.equal(f.store.get(`merge:${f.repo.id}:${issue.id}`), null);
  await f.merge();
  assert.deepEqual(f.merges, []);
});
