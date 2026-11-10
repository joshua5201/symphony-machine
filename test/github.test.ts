import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  GitHub,
  runCommand,
  type CommandResult,
  type CommandRunner,
  type RepositoryConfig,
} from "../src/github.js";

const okay = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", args, cwd);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

function rawPr(
  head: string,
  branch = "symphony/eng-1",
  overrides: Record<string, unknown> = {},
) {
  return {
    number: 7,
    url: "https://github.com/test/repo/pull/7",
    headRefOid: head,
    baseRefName: "master",
    headRefName: branch,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    updatedAt: "2026-11-07T00:00:00Z",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

async function fixture(
  t: TestContext,
  gh?: (args: string[]) => Promise<CommandResult> | CommandResult,
) {
  const directory = await mkdtemp(join(tmpdir(), "symphony-github-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const path = join(directory, "checkout");
  const seed = join(directory, "seed");
  await git(directory, "init", "--bare", "--initial-branch=master", remote);
  await git(directory, "clone", remote, seed);
  await git(seed, "config", "user.name", "Test");
  await git(seed, "config", "user.email", "test@example.com");
  await writeFile(join(seed, "base.txt"), "base\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "baseline");
  await git(seed, "push", "origin", "master");
  await git(directory, "clone", remote, path);
  await git(path, "config", "user.name", "Test");
  await git(path, "config", "user.email", "test@example.com");
  const config: RepositoryConfig = {
    id: "test",
    path,
    github: "test/repo",
    branch: "master",
    remote: "origin",
    worktreeRoot: join(directory, "worktrees"),
  };
  const calls: string[][] = [];
  const runner: CommandRunner = async (file, args, cwd) => {
    if (file === "git") return runCommand(file, args, cwd);
    calls.push(args);
    if (!gh) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return gh(args);
  };
  return {
    directory,
    path,
    seed,
    remote,
    config,
    calls,
    runner,
    github: new GitHub(config, runner),
  };
}

test("maintenance target commit follows the remote without changing the shared checkout", async (t) => {
  const f = await fixture(t);
  const localHead = await git(f.path, "rev-parse", "HEAD");
  await writeFile(join(f.path, "base.txt"), "local work in progress\n");
  await writeFile(join(f.seed, "base.txt"), "remote advance\n");
  await git(f.seed, "commit", "-am", "advance target");
  await git(f.seed, "push", "origin", "master");
  const target = await f.github.targetCommit();
  assert.equal(target, await git(f.seed, "rev-parse", "HEAD"));
  assert.notEqual(target, localHead);
  assert.equal(await git(f.path, "rev-parse", "HEAD"), localHead);
  assert.equal(
    await readFile(join(f.path, "base.txt"), "utf8"),
    "local work in progress\n",
  );
});

test("prepare starts from fresh remote target and resumes its owned worktree with dirty work preserved", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.seed, "new.txt"), "new target\n");
  await git(f.seed, "add", ".");
  await git(f.seed, "commit", "-m", "target advanced");
  await git(f.seed, "push", "origin", "master");
  const target = await git(f.seed, "rev-parse", "HEAD");
  assert.notEqual(await git(f.path, "rev-parse", "HEAD"), target);
  const workspace = await f.github.prepare("ENG-1");
  assert.equal(workspace.branch, "symphony/eng-1");
  assert.equal(workspace.baseline, target);
  assert.equal(await git(workspace.path, "rev-parse", "HEAD"), target);
  await writeFile(join(workspace.path, "working.txt"), "unfinished");
  assert.deepEqual(
    await new GitHub(f.config, f.runner).prepare("ENG-1"),
    workspace,
  );
  assert.equal(
    await readFile(join(workspace.path, "working.txt"), "utf8"),
    "unfinished",
  );
});

test("repo-local runtime worktrees stay out of the shared checkout's tracked work", async (t) => {
  const f = await fixture(t);
  const config = {
    ...f.config,
    worktreeRoot: join(f.path, ".symphony", "worktrees"),
  };
  const github = new GitHub(config, f.runner);
  const workspace = await github.prepare("ENG-1");
  assert.equal(workspace.path, await realpath(join(config.worktreeRoot, "eng-1")));
  await writeFile(join(workspace.path, "working.txt"), "unfinished");
  assert.equal(
    await git(f.path, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
  assert.match(await git(f.path, "check-ignore", workspace.path), /eng-1$/);
  assert.match(
    await git(workspace.path, "status", "--porcelain"),
    /working\.txt/,
  );
});

test("prepare refuses to adopt an existing unmanaged branch", async (t) => {
  const f = await fixture(t);
  await git(f.path, "branch", "symphony/eng-1");
  await assert.rejects(f.github.prepare("ENG-1"), /unmanaged/);
});

test("cleanup removes a clean owned squash-merged worktree and exact branches, and is idempotent", async (t) => {
  let pr = rawPr("");
  const f = await fixture(t, (args) => {
    assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
    return okay(JSON.stringify(pr));
  });
  const workspace = await f.github.prepare("ENG-1");
  await writeFile(join(workspace.path, "feature.txt"), "feature\n");
  await git(workspace.path, "add", ".");
  await git(workspace.path, "commit", "-m", "feature");
  const head = await git(workspace.path, "rev-parse", "HEAD");
  await git(workspace.path, "push", "origin", workspace.branch);
  await git(f.seed, "fetch", "origin", workspace.branch);
  await git(f.seed, "merge", "--squash", "FETCH_HEAD");
  await git(f.seed, "commit", "-m", "squashed feature");
  await git(f.seed, "push", "origin", "master");
  const ancestry = await runCommand(
    "git",
    ["merge-base", "--is-ancestor", head, "master"],
    f.seed,
  );
  assert.equal(
    ancestry.code,
    1,
    "fixture is a squash merge, not an ancestor merge",
  );
  pr = rawPr(head, workspace.branch, { state: "MERGED" });
  await f.github.cleanup(workspace, 7);
  await assert.rejects(readFile(join(workspace.path, "feature.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    await git(
      f.path,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${workspace.branch}`,
    ),
    "",
  );
  assert.equal(
    (
      await runCommand(
        "git",
        ["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`],
        f.path,
      )
    ).code,
    1,
  );
  await f.github.cleanup(workspace, 7);
});

test("cleanup preserves a dirty worktree and both branches", async (t) => {
  let pr = rawPr("");
  const f = await fixture(t, () => okay(JSON.stringify(pr)));
  const workspace = await f.github.prepare("ENG-1");
  const head = await git(workspace.path, "rev-parse", "HEAD");
  await git(workspace.path, "push", "origin", workspace.branch);
  await writeFile(join(workspace.path, "unfinished.txt"), "keep me");
  pr = rawPr(head, workspace.branch, { state: "MERGED" });
  await assert.rejects(f.github.cleanup(workspace, 7), /dirty/);
  assert.equal(
    await readFile(join(workspace.path, "unfinished.txt"), "utf8"),
    "keep me",
  );
  assert.match(
    await git(
      f.path,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${workspace.branch}`,
    ),
    new RegExp(head),
  );
  assert.equal(await git(workspace.path, "rev-parse", "HEAD"), head);
});

test("cleanup accepts clean local work already contained in a server-updated merged PR", async (t) => {
  let pr = rawPr("");
  const f = await fixture(t, () => okay(JSON.stringify(pr)));
  const workspace = await f.github.prepare("ENG-1");
  const localHead = await git(workspace.path, "rev-parse", "HEAD");
  await git(workspace.path, "push", "origin", workspace.branch);
  await git(f.seed, "switch", "-c", workspace.branch);
  await writeFile(join(f.seed, "server-update.txt"), "merged base update\n");
  await git(f.seed, "add", ".");
  await git(f.seed, "commit", "-m", "server branch update");
  await git(
    f.seed,
    "push",
    "origin",
    workspace.branch,
    "HEAD:refs/pull/7/head",
  );
  const head = await git(f.seed, "rev-parse", "HEAD");
  assert.notEqual(localHead, head);
  pr = rawPr(head, workspace.branch, { state: "MERGED" });
  await f.github.cleanup(workspace, 7);
  assert.equal(
    await git(
      f.path,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${workspace.branch}`,
    ),
    "",
  );
  await assert.rejects(readFile(join(workspace.path, "base.txt")), {
    code: "ENOENT",
  });
});

test("cleanup preserves a remote branch advanced after the merged PR", async (t) => {
  let pr = rawPr("");
  const f = await fixture(t, () => okay(JSON.stringify(pr)));
  const workspace = await f.github.prepare("ENG-1");
  const mergedHead = await git(workspace.path, "rev-parse", "HEAD");
  await git(workspace.path, "push", "origin", workspace.branch);
  await git(f.seed, "switch", "-c", workspace.branch);
  await writeFile(join(f.seed, "later.txt"), "later work");
  await git(f.seed, "add", ".");
  await git(f.seed, "commit", "-m", "later work");
  await git(f.seed, "push", "origin", workspace.branch);
  const later = await git(f.seed, "rev-parse", "HEAD");
  pr = rawPr(mergedHead, workspace.branch, { state: "MERGED" });
  await assert.rejects(f.github.cleanup(workspace, 7), /Remote branch changed/);
  assert.match(
    await git(
      f.path,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${workspace.branch}`,
    ),
    new RegExp(later),
  );
  assert.equal(await git(workspace.path, "rev-parse", "HEAD"), mergedHead);
});

test("cleanup refuses a local branch with commits outside the merged PR", async (t) => {
  let pr = rawPr("");
  const f = await fixture(t, () => okay(JSON.stringify(pr)));
  const workspace = await f.github.prepare("ENG-1");
  const mergedHead = await git(workspace.path, "rev-parse", "HEAD");
  await git(
    workspace.path,
    "push",
    "origin",
    workspace.branch,
    "HEAD:refs/pull/7/head",
  );
  await writeFile(join(workspace.path, "later-local.txt"), "unmerged work\n");
  await git(workspace.path, "add", ".");
  await git(workspace.path, "commit", "-m", "unmerged local work");
  const later = await git(workspace.path, "rev-parse", "HEAD");
  pr = rawPr(mergedHead, workspace.branch, { state: "MERGED" });
  await assert.rejects(f.github.cleanup(workspace, 7), /Local branch changed/);
  assert.equal(await git(workspace.path, "rev-parse", "HEAD"), later);
  assert.match(
    await git(
      f.path,
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${workspace.branch}`,
    ),
    new RegExp(mergedHead),
  );
});

test("PR facts conservatively distinguish missing, pending, and failed checks", async (t) => {
  let pr = rawPr("head", undefined, { statusCheckRollup: [] });
  const f = await fixture(t, (args) =>
    okay(JSON.stringify(args[1] === "list" ? [pr] : pr)),
  );
  assert.equal((await f.github.pr(7)).checks, "unknown");
  pr = rawPr("head", undefined, {
    statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }],
  });
  assert.equal((await f.github.pr(7)).checks, "pending");
  pr = rawPr("head", undefined, { statusCheckRollup: [{ state: "FAILURE" }] });
  assert.equal((await f.github.findPr("symphony/eng-1"))?.checks, "failure");
});

function reviewContextFixture(pages: Record<string, unknown[][]>) {
  const calls: string[][] = [];
  const github = new GitHub(
    {
      id: "review",
      path: tmpdir(),
      github: "demo/repo",
      branch: "main",
      remote: "origin",
      worktreeRoot: join(tmpdir(), "unused-review-worktrees"),
    },
    async (file, args) => {
      assert.equal(file, "gh", "reading review context must not mutate Git");
      assert.equal(args[0], "api");
      assert.deepEqual(args.slice(2), ["--paginate", "--slurp"]);
      calls.push(args);
      const response = pages[args[1]];
      assert.ok(response, `Unexpected review endpoint: ${args[1]}`);
      return okay(JSON.stringify(response));
    },
  );
  return { github, calls };
}

const reviewEndpoint = "repos/demo/repo/pulls/7/reviews?per_page=100";
const commentEndpoint = "repos/demo/repo/issues/7/comments?per_page=100";
const inlineEndpoint = "repos/demo/repo/pulls/7/comments?per_page=100";

function reviewComment(id: number, body: string) {
  return {
    id,
    user: { login: "lead", avatar_url: "not needed in review context" },
    body,
    html_url: `https://github.com/demo/repo/pull/7#issuecomment-${id}`,
    created_at: "2026-11-10T01:00:00Z",
    updated_at: "2026-11-10T01:00:00Z",
  };
}

test("PR review context includes every page and preserves commit and reply associations", async () => {
  const comments = Array.from({ length: 101 }, (_, index) =>
    reviewComment(index + 1, `Discussion ${index + 1}`),
  );
  const pages = {
    [reviewEndpoint]: [[{
      id: 200,
      user: { login: "reviewer" },
      body: "One finding remains.",
      html_url: "https://github.com/demo/repo/pull/7#pullrequestreview-200",
      state: "CHANGES_REQUESTED",
      commit_id: "reviewed-head",
      submitted_at: "2026-11-10T01:00:00Z",
    }]],
    [commentEndpoint]: [comments.slice(0, 100), comments.slice(100)],
    [inlineEndpoint]: [[{
      ...reviewComment(300, "Finding on the previous head"),
      user: null,
      pull_request_review_id: 200,
      path: "src/example.ts",
      commit_id: "current-head",
      original_commit_id: "reviewed-head",
      line: null,
      original_line: 12,
      side: "RIGHT",
    }], [{
      ...reviewComment(301, "Rejected: this behavior follows the requirement."),
      pull_request_review_id: 201,
      in_reply_to_id: 300,
      path: "src/example.ts",
      commit_id: "current-head",
      original_commit_id: "reviewed-head",
      line: 15,
      original_line: 12,
      side: "RIGHT",
    }]],
  };
  const { github, calls } = reviewContextFixture(pages);
  const context = await github.reviewContext(7);
  assert.equal(context.comments.length, 101);
  assert.equal(context.comments.at(-1)?.body, "Discussion 101");
  assert.equal(context.comments[0].author, "lead");
  assert.equal(context.comments[0].updatedAt, "2026-11-10T01:00:00Z");
  assert.equal(context.reviews[0].commitId, "reviewed-head");
  assert.equal(context.reviews[0].state, "CHANGES_REQUESTED");
  assert.equal(context.inlineComments[0].author, null);
  assert.equal(context.inlineComments[0].line, null);
  assert.equal(context.inlineComments[0].originalLine, 12);
  assert.equal(context.inlineComments[1].inReplyToId, 300);
  assert.equal(context.inlineComments[1].reviewId, 201);
  assert.equal(context.inlineComments[1].originalCommitId, "reviewed-head");
  assert.equal(context.inlineComments[1].commitId, "current-head");
  assert.equal(context.inlineComments[1].body,
    "Rejected: this behavior follows the requirement.");
  assert.equal(JSON.stringify(context).includes("avatar_url"), false);
  assert.match(context.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(new Set(calls.map((args) => args[1])),
    new Set([reviewEndpoint, commentEndpoint, inlineEndpoint]));

  // API ordering and page boundaries must not create spurious review work.
  pages[commentEndpoint].reverse();
  pages[inlineEndpoint].reverse();
  assert.equal((await github.reviewContext(7)).fingerprint, context.fingerprint);
});

test("PR review fingerprint detects replies and edits without a new commit", async () => {
  const finding = {
    ...reviewComment(300, "Please fix this behavior."),
    pull_request_review_id: 200,
    path: "src/example.ts",
    commit_id: "same-head",
    original_commit_id: "same-head",
  };
  const review = {
    id: 200,
    user: { login: "reviewer" },
    body: "Please address the inline finding.",
    html_url: "https://github.com/demo/repo/pull/7#pullrequestreview-200",
    state: "CHANGES_REQUESTED",
    commit_id: "same-head",
    submitted_at: "2026-11-10T01:00:00Z",
  };
  const pages: Record<string, unknown[][]> = {
    [reviewEndpoint]: [[review]],
    [commentEndpoint]: [[]],
    [inlineEndpoint]: [[finding]],
  };
  const { github } = reviewContextFixture(pages);
  let previous = (await github.reviewContext(7)).fingerprint;
  const assertChanged = async () => {
    const context = await github.reviewContext(7);
    assert.notEqual(context.fingerprint, previous);
    assert.equal(context.reviews[0].commitId, "same-head");
    previous = context.fingerprint;
  };

  const reply = {
    ...finding,
    ...reviewComment(301, "Rejected because the existing requirement covers this."),
    in_reply_to_id: 300,
  };
  pages[inlineEndpoint][0].push(reply);
  await assertChanged();
  reply.body = "Rejected: the requirement explicitly permits this case.";
  reply.updated_at = "2026-11-10T01:05:00Z";
  await assertChanged();
  pages[commentEndpoint][0].push(reviewComment(400, "Ready for another review."));
  await assertChanged();
  // Review edits have no updated_at field in REST, so the body is hashed too.
  review.body = "The finding is resolved.";
  await assertChanged();
  review.state = "DISMISSED";
  await assertChanged();
  pages[inlineEndpoint][0].pop();
  await assertChanged();
});

test("merge pins the reviewed head and refuses changed heads, wrong targets, or unknown required checks", async (t) => {
  let pr = rawPr("reviewed");
  let required = okay(JSON.stringify([{ bucket: "pass" }]));
  const f = await fixture(t, (args) => {
    if (args[1] === "view") return okay(JSON.stringify(pr));
    if (args[1] === "checks") return required;
    if (args[1] === "merge") return okay();
    throw new Error("Unexpected gh command");
  });
  await f.github.merge(7, "reviewed");
  assert.deepEqual(
    f.calls.find((args) => args[1] === "merge"),
    [
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      "reviewed",
      "--repo",
      "test/repo",
    ],
  );
  f.calls.length = 0;
  await assert.rejects(f.github.merge(7, "old-head"), /head changed/);
  pr = rawPr("reviewed", undefined, { baseRefName: "elsewhere" });
  await assert.rejects(f.github.merge(7, "reviewed"), /targets elsewhere/);
  pr = rawPr("reviewed");
  required = okay(JSON.stringify([{ bucket: "pending" }]));
  await assert.rejects(f.github.merge(7, "reviewed"), /Required checks/);
  required = { code: 1, stdout: "", stderr: "GraphQL: access denied" };
  await assert.rejects(
    f.github.merge(7, "reviewed"),
    /Cannot verify required checks/,
  );
  assert.equal(f.calls.filter((args) => args[1] === "merge").length, 0);
});

test("master health requires configured workflows on the exact remote target SHA", async (t) => {
  let mode: "missing" | "passing" | "pending" = "missing";
  const f = await fixture(t, (args) => {
    assert.deepEqual(args.slice(0, 2), ["run", "list"]);
    const sha = args[args.indexOf("--commit") + 1];
    const workflow = args[args.indexOf("--workflow") + 1];
    if (mode === "missing" && workflow === "release.yml") return okay("[]");
    return okay(
      JSON.stringify([
        {
          workflowDatabaseId: 1,
          headSha: sha,
          status: mode === "pending" ? "in_progress" : "completed",
          conclusion: mode === "pending" ? "" : "success",
          url: "https://github.com/test/repo/actions/runs/1",
        },
      ]),
    );
  });
  const github = new GitHub(
    { ...f.config, requiredWorkflows: ["CI", "release.yml"] },
    f.runner,
  );
  assert.equal((await github.masterHealth()).status, "unknown");
  mode = "passing";
  const health = await github.masterHealth();
  assert.equal(health.status, "success");
  assert.equal(health.sha, await git(f.seed, "rev-parse", "HEAD"));
  mode = "pending";
  assert.equal((await github.masterHealth()).status, "pending");
});

test("updateBranch reports current, updated, and conflict without hiding service errors", async (t) => {
  let pr = rawPr("before");
  let update: "current" | "updated" | "error" = "current";
  const f = await fixture(t, (args) => {
    if (args[1] === "view") return okay(JSON.stringify(pr));
    if (update === "error")
      return { code: 1, stdout: "", stderr: "network unavailable" };
    if (update === "updated") pr = rawPr("after");
    return okay();
  });
  assert.equal(await f.github.updateBranch(7), "current");
  update = "updated";
  assert.equal(await f.github.updateBranch(7), "updated");
  pr = rawPr("after", undefined, { mergeable: "CONFLICTING" });
  assert.equal(await f.github.updateBranch(7), "conflict");
  pr = rawPr("after");
  update = "error";
  await assert.rejects(f.github.updateBranch(7), /network unavailable/);
});

const androidWorkflows = [
  {
    name: "Android debug artifacts",
    path: ".github/workflows/android-debug.yml",
    state: "active",
  },
  {
    name: "Website CI",
    path: ".github/workflows/website-ci.yml",
    state: "active",
  },
  {
    name: "Prepare Android release PR",
    path: ".github/workflows/android-release-prep.yml",
    state: "active",
  },
  {
    name: "Attach signed AABs to draft release",
    path: ".github/workflows/android-release.yml",
    state: "active",
  },
];

function workflowValidation(
  requiredWorkflows: string[],
  workflows = androidWorkflows,
) {
  const calls: string[][] = [];
  const github = new GitHub(
    {
      id: "tracker",
      path: tmpdir(),
      github: "demo/repo",
      branch: "main",
      remote: "origin",
      worktreeRoot: join(tmpdir(), "unused-worktrees"),
      requiredWorkflows,
    },
    async (file, args) => {
      assert.equal(
        file,
        "gh",
        "workflow validation must not fetch or mutate Git",
      );
      assert.deepEqual(args.slice(0, 2), ["workflow", "list"]);
      assert.ok(
        args.includes("--all"),
        "disabled workflows must be available for diagnostics",
      );
      calls.push(args);
      return okay(JSON.stringify(workflows));
    },
  );
  return { github, calls };
}

test("workflow preflight accepts the actual Android CI name, filename, and full path without Git mutations", async () => {
  const { github, calls } = workflowValidation([
    "Android debug artifacts",
    "android-debug.yml",
    ".github/workflows/android-debug.yml",
  ]);
  await github.validateWorkflows();
  assert.equal(calls.length, 1);
});

test("workflow preflight reports missing ci.yml with the repository's available names and paths", async () => {
  const { github } = workflowValidation(["ci.yml"]);
  await assert.rejects(github.validateWorkflows(), (error: Error) => {
    assert.match(
      error.message,
      /Invalid required_workflows for demo\/repo/,
    );
    assert.match(error.message, /"ci\.yml" does not exist/);
    assert.match(
      error.message,
      /Android debug artifacts \(\.github\/workflows\/android-debug\.yml, active\)/,
    );
    assert.match(
      error.message,
      /Configure an existing active CI workflow name or path/,
    );
    return true;
  });
});

test("workflow preflight rejects an existing disabled CI workflow", async () => {
  const { github } = workflowValidation(
    ["android-debug.yml"],
    [{ ...androidWorkflows[0], state: "disabled_manually" }],
  );
  await assert.rejects(
    github.validateWorkflows(),
    /"android-debug\.yml" is disabled_manually/,
  );
});
