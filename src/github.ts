import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type CheckStatus = "pending" | "success" | "failure" | "unknown";

export interface RepositoryConfig {
  id: string;
  path: string;
  github: string;
  branch: string;
  remote: string;
  worktreeRoot: string;
  /** Workflow names or file paths. Missing runs never count as success. */
  requiredWorkflows?: string[];
}

export interface PrInfo {
  number: number;
  url: string;
  head: string;
  base: string;
  branch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: string;
  checks: CheckStatus;
  reviewDecision: string;
  updatedAt: string;
}

export interface Workspace {
  path: string;
  branch: string;
  baseline: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (
  file: "git" | "gh",
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

/** Credentials stay in the caller's environment or existing Git/gh login. */
export const runCommand: CommandRunner = (file, args, cwd) =>
  new Promise((done, reject) => {
    execFile(
      file,
      args,
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        done({ stdout, stderr, code: error ? Number(error.code) : 0 });
      },
    );
  });

interface RawPr {
  number: number;
  url: string;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  state: PrInfo["state"];
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  updatedAt: string;
  statusCheckRollup:
    { status?: string; conclusion?: string; state?: string }[] | null;
}

interface WorkflowRun {
  workflowDatabaseId: number;
  status: string;
  conclusion: string;
  headSha: string;
  url: string;
}

interface Ownership {
  repo: string;
  path: string;
  baseline: string;
}
interface Worktree {
  path: string;
  branch?: string;
}

const prFields =
  "number,url,headRefOid,baseRefName,headRefName,state,isDraft,mergeable,reviewDecision,updatedAt,statusCheckRollup";
const runFields = "workflowDatabaseId,status,conclusion,headSha,url";
const issuePattern = /^[a-z0-9][a-z0-9_-]*$/;

// Git records canonical worktree paths (notably /private/tmp on macOS).
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(canonicalPath(dirname(absolute)), basename(absolute));
  }
}

function aggregate(statuses: CheckStatus[]): CheckStatus {
  if (!statuses.length) return "unknown";
  if (statuses.includes("failure")) return "failure";
  if (statuses.includes("pending")) return "pending";
  if (statuses.includes("unknown")) return "unknown";
  return "success";
}

function checkStatus(check: {
  status?: string;
  conclusion?: string;
  state?: string;
}): CheckStatus {
  const state = (check.conclusion || check.state || "").toUpperCase();
  if (check.status && check.status.toUpperCase() !== "COMPLETED")
    return "pending";
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) return "success";
  if (
    [
      "PENDING",
      "EXPECTED",
      "QUEUED",
      "IN_PROGRESS",
      "WAITING",
      "REQUESTED",
    ].includes(state)
  )
    return "pending";
  if (
    [
      "FAILURE",
      "ERROR",
      "CANCELLED",
      "TIMED_OUT",
      "ACTION_REQUIRED",
      "STARTUP_FAILURE",
      "STALE",
    ].includes(state)
  )
    return "failure";
  return "unknown";
}

function toPr(raw: RawPr): PrInfo {
  return {
    number: raw.number,
    url: raw.url,
    head: raw.headRefOid,
    base: raw.baseRefName,
    branch: raw.headRefName,
    state: raw.state,
    draft: raw.isDraft,
    mergeable: raw.mergeable,
    checks: aggregate((raw.statusCheckRollup ?? []).map(checkStatus)),
    reviewDecision: raw.reviewDecision ?? "",
    updatedAt: raw.updatedAt,
  };
}

export class GitHub {
  readonly repo: RepositoryConfig;
  private readonly runner: CommandRunner;

  constructor(repo: RepositoryConfig, runner: CommandRunner = runCommand) {
    this.repo = {
      ...repo,
      path: canonicalPath(repo.path),
      worktreeRoot: canonicalPath(repo.worktreeRoot),
    };
    this.runner = runner;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repo.remote))
      throw new Error("Invalid Git remote name");
    if (!repo.branch || repo.branch.startsWith("-"))
      throw new Error("Invalid target branch");
  }

  private async command(
    file: "git" | "gh",
    args: string[],
    cwd = this.repo.path,
  ): Promise<string> {
    const result = await this.runner(file, args, cwd);
    if (result.code !== 0)
      throw new Error(
        `${file} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
      );
    return result.stdout.trim();
  }

  private gh(args: string[]): Promise<string> {
    return this.command("gh", [...args, "--repo", this.repo.github]);
  }

  private async fetchTarget(): Promise<string> {
    await this.command("git", [
      "check-ref-format",
      `refs/heads/${this.repo.branch}`,
    ]);
    const ref = `refs/remotes/${this.repo.remote}/${this.repo.branch}`;
    await this.command("git", [
      "fetch",
      "--no-tags",
      this.repo.remote,
      `+refs/heads/${this.repo.branch}:${ref}`,
    ]);
    return this.command("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  }

  private async worktrees(): Promise<Worktree[]> {
    const output = await this.command("git", [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const result: Worktree[] = [];
    let current: Worktree | undefined;
    for (const field of output.split("\0")) {
      if (field.startsWith("worktree ")) {
        current = { path: resolve(field.slice(9)) };
        result.push(current);
      } else if (current && field.startsWith("branch refs/heads/")) {
        current.branch = field.slice(18);
      }
    }
    return result;
  }

  private ownerKey(branch: string): string {
    return `branch.${branch}.symphony-owner`;
  }

  private async ownership(branch: string): Promise<Ownership | null> {
    const result = await this.runner(
      "git",
      ["config", "--local", "--get", this.ownerKey(branch)],
      this.repo.path,
    );
    if (result.code === 1) return null;
    if (result.code !== 0)
      throw new Error(
        `Cannot read workspace ownership: ${result.stderr.trim()}`,
      );
    return JSON.parse(result.stdout) as Ownership;
  }

  private async localHead(branch: string): Promise<string | null> {
    const result = await this.runner(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      this.repo.path,
    );
    if (result.code === 1) return null;
    if (result.code !== 0)
      throw new Error(`Cannot read local branch: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  private workspacePath(branch: string): string {
    const issue = branch.slice("symphony/".length);
    if (!branch.startsWith("symphony/") || !issuePattern.test(issue))
      throw new Error("Not a managed Symphony branch");
    return resolve(this.repo.worktreeRoot, issue);
  }

  async prepare(issueId: string): Promise<Workspace> {
    const issue = issueId.toLowerCase();
    if (!issuePattern.test(issue))
      throw new Error(
        "Issue ID must contain only letters, numbers, underscores, and hyphens",
      );
    const branch = `symphony/${issue}`;
    const path = this.workspacePath(branch);
    const baseline = await this.fetchTarget();
    const owner = await this.ownership(branch);
    const head = await this.localHead(branch);
    const worktree = (await this.worktrees()).find(
      (entry) => entry.path === path,
    );
    if (owner && (owner.repo !== this.repo.id || owner.path !== path))
      throw new Error("Workspace ownership does not match");
    if ((head || worktree) && !owner)
      throw new Error(
        "Refusing to adopt an existing unmanaged branch or worktree",
      );
    if (worktree) {
      if (worktree.branch !== branch)
        throw new Error("Workspace is on a different branch");
      await lstat(path);
      return { path, branch, baseline: owner!.baseline };
    }
    try {
      await lstat(path);
      throw new Error(
        "Workspace path already exists outside the managed worktree",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.repo.worktreeRoot, { recursive: true });
    const metadata: Ownership = owner ?? { repo: this.repo.id, path, baseline };
    // Record ownership before creating the worktree so a restart can resume it.
    await this.command("git", [
      "config",
      "--local",
      this.ownerKey(branch),
      JSON.stringify(metadata),
    ]);
    await this.command("git", [
      "worktree",
      "add",
      ...(head ? [] : ["-b", branch]),
      "--",
      path,
      head ? branch : metadata.baseline,
    ]);
    return { path, branch, baseline: metadata.baseline };
  }

  async pr(number: number): Promise<PrInfo> {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("Invalid pull request number");
    return toPr(
      JSON.parse(
        await this.gh(["pr", "view", String(number), "--json", prFields]),
      ) as RawPr,
    );
  }

  async findPr(branch: string): Promise<PrInfo | null> {
    const prs = JSON.parse(
      await this.gh([
        "pr",
        "list",
        "--head",
        branch,
        "--base",
        this.repo.branch,
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        prFields,
      ]),
    ) as RawPr[];
    const matches = prs.filter(
      (pr) => pr.headRefName === branch && pr.baseRefName === this.repo.branch,
    );
    const pr = matches.find((pr) => pr.state === "OPEN") ?? matches[0];
    return pr ? toPr(pr) : null;
  }

  async masterHealth(): Promise<{
    sha: string;
    status: CheckStatus;
    url?: string;
  }> {
    const sha = await this.fetchTarget();
    const workflows = this.repo.requiredWorkflows;
    let runs: WorkflowRun[];
    let missing = false;
    const args = [
      "run",
      "list",
      "--branch",
      this.repo.branch,
      "--commit",
      sha,
      "--json",
      runFields,
    ];
    if (workflows?.length) {
      runs = [];
      for (const workflow of workflows) {
        const found = JSON.parse(
          await this.gh([...args, "--workflow", workflow, "--limit", "1"]),
        ) as WorkflowRun[];
        const run = found.find((run) => run.headSha === sha);
        if (run) runs.push(run);
        else missing = true;
      }
    } else {
      const found = JSON.parse(
        await this.gh([...args, "--limit", "100"]),
      ) as WorkflowRun[];
      const latest = new Map<number, WorkflowRun>();
      for (const run of found)
        if (run.headSha === sha && !latest.has(run.workflowDatabaseId))
          latest.set(run.workflowDatabaseId, run);
      runs = [...latest.values()];
    }
    const states = runs.map((run) =>
      checkStatus({ status: run.status, conclusion: run.conclusion }),
    );
    if (missing) states.push("unknown");
    const status = aggregate(states);
    const url =
      runs.find((_, index) => states[index] === status)?.url ?? runs[0]?.url;
    return { sha, status, ...(url ? { url } : {}) };
  }

  private assertTarget(pr: PrInfo): void {
    if (pr.base !== this.repo.branch)
      throw new Error(
        `PR #${pr.number} targets ${pr.base}, expected ${this.repo.branch}`,
      );
  }

  async updateBranch(
    number: number,
  ): Promise<"updated" | "current" | "conflict"> {
    const before = await this.pr(number);
    this.assertTarget(before);
    if (before.state !== "OPEN")
      throw new Error("Only open pull requests can be updated");
    if (before.mergeable === "CONFLICTING") return "conflict";
    const result = await this.runner(
      "gh",
      ["pr", "update-branch", String(number), "--repo", this.repo.github],
      this.repo.path,
    );
    if (result.code !== 0) {
      if (
        /cannot update PR branch due to conflicts|merge conflict between base and head/i.test(
          result.stderr + result.stdout,
        )
      )
        return "conflict";
      throw new Error(
        `Cannot update PR branch: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return (await this.pr(number)).head === before.head ? "current" : "updated";
  }

  async merge(number: number, expectedHead: string): Promise<void> {
    const pr = await this.pr(number);
    this.assertTarget(pr);
    if (pr.head !== expectedHead)
      throw new Error("PR head changed before merge");
    if (pr.state !== "OPEN" || pr.draft || pr.mergeable !== "MERGEABLE")
      throw new Error("PR is not ready to merge");
    if (pr.checks !== "success") throw new Error(`PR checks are ${pr.checks}`);
    if (["REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pr.reviewDecision))
      throw new Error(`PR review decision is ${pr.reviewDecision}`);
    const required = await this.runner(
      "gh",
      [
        "pr",
        "checks",
        String(number),
        "--required",
        "--json",
        "bucket,name",
        "--repo",
        this.repo.github,
      ],
      this.repo.path,
    );
    if (required.code !== 0) {
      if (
        !/^no required checks reported on the '.+' branch\s*$/.test(
          required.stderr.trim(),
        )
      ) {
        throw new Error(
          `Cannot verify required checks: ${(required.stderr || required.stdout).trim()}`,
        );
      }
    } else {
      const checks = JSON.parse(required.stdout) as { bucket: string }[];
      if (checks.some((check) => !["pass", "skipping"].includes(check.bucket)))
        throw new Error("Required checks have not passed");
    }
    await this.gh([
      "pr",
      "merge",
      String(number),
      "--squash",
      "--match-head-commit",
      expectedHead,
    ]);
  }

  async cleanup(
    workspace: { path: string; branch: string },
    prNumber: number,
  ): Promise<void> {
    const path = canonicalPath(workspace.path);
    if (path !== this.workspacePath(workspace.branch))
      throw new Error("Workspace path is outside its managed location");
    const pr = await this.pr(prNumber);
    this.assertTarget(pr);
    if (pr.state !== "MERGED" || pr.branch !== workspace.branch || !pr.head)
      throw new Error("Cleanup requires the matching merged pull request");
    const owner = await this.ownership(workspace.branch);
    const head = await this.localHead(workspace.branch);
    const worktree = (await this.worktrees()).find(
      (entry) => entry.path === path,
    );
    const remote = await this.command("git", [
      "ls-remote",
      "--heads",
      this.repo.remote,
      `refs/heads/${workspace.branch}`,
    ]);
    const remoteHead = remote.split(/\s+/)[0];
    if (!head && !worktree && !remoteHead && !owner) return;
    if (!owner || owner.repo !== this.repo.id || owner.path !== path)
      throw new Error("Cleanup requires owned workspace metadata");
    if (remoteHead && remoteHead !== pr.head)
      throw new Error("Remote branch changed since the merged PR");
    if (worktree) {
      if (worktree.branch !== workspace.branch)
        throw new Error("Workspace is on a different branch");
      const dirty = await this.command(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        path,
      );
      if (dirty) throw new Error("Refusing to remove a dirty workspace");
    }
    if (head && head !== pr.head) {
      // Updating a PR on GitHub can leave the idle local worktree behind.
      // Fetch the retained PR ref, then prove all local work is in that PR.
      await this.command("git", [
        "fetch",
        "--no-tags",
        this.repo.remote,
        `refs/pull/${prNumber}/head`,
      ]);
      const fetched = await this.command("git", [
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}",
      ]);
      if (fetched !== pr.head)
        throw new Error("Fetched PR head does not match the merged PR");
      const ancestor = await this.runner(
        "git",
        ["merge-base", "--is-ancestor", head, pr.head],
        this.repo.path,
      );
      if (ancestor.code !== 0)
        throw new Error("Local branch changed since the merged PR");
    }
    if (remoteHead) {
      await this.command("git", [
        "push",
        `--force-with-lease=refs/heads/${workspace.branch}:${pr.head}`,
        this.repo.remote,
        `:refs/heads/${workspace.branch}`,
      ]);
    }
    if (worktree) await this.command("git", ["worktree", "remove", "--", path]);
    // Squash merges do not make the PR head an ancestor of the target branch.
    // The merged PR and head/ancestry checks above authorize deletion.
    if (head)
      await this.command("git", ["branch", "-D", "--", workspace.branch]);
    else
      await this.command("git", [
        "config",
        "--local",
        "--remove-section",
        `branch.${workspace.branch}`,
      ]);
  }
}
