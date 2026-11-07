#!/usr/bin/env node
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { LinearClient } from "./linear.js";
import { CodexRunner } from "./codex.js";
import { Machine } from "./machine.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1]) throw new Error(`Missing ${name} value`);
  return args[i + 1];
};
async function main() {
  if (command === "help" || args.includes("--help")) {
    console.log(
      `Symphony Machine — personal foreground runner\n\n  npm start -- run --config symphony.yaml\n  npm start -- doctor --config symphony.yaml\n  npm start -- linear-login --config symphony.yaml\n  npm start -- status --config symphony.yaml\n  npm start -- pause|resume --repo all --config symphony.yaml\n  npm start -- retry --issue TEAM-123 --config symphony.yaml\n\nFirst Ctrl+C drains active work. Second Ctrl+C interrupts and saves resumable state.\nPolling, concurrency and maintenance settings reload automatically; other changes need restart.`,
    );
    return;
  }
  const file = resolve(option("--config", "symphony.yaml"));
  let config = loadConfig(file);
  mkdirSync(config.data_dir, { recursive: true, mode: 0o700 });
  const log = (event: string, details?: unknown) => {
    const row = JSON.stringify({
      time: new Date().toISOString(),
      event,
      ...(details && typeof details === "object" ? details : { details }),
    });
    console.log(row);
    appendFileSync(resolve(config.data_dir, "events.jsonl"), row + "\n", {
      mode: 0o600,
    });
  };
  const linear = new LinearClient({
    url: config.linear.url,
    authDir: resolve(config.data_dir, "linear-auth"),
    onAuthUrl: (url) =>
      console.log(`Open this URL to authorize Linear:\n${url}`),
  });
  if (command === "linear-login") {
    try {
      await linear.login();
      console.log(
        "Linear OAuth is configured for the controller. Configure Codex MCP separately as described in README.",
      );
    } finally {
      await linear.close();
    }
    return;
  }
  const store = new Store(resolve(config.data_dir, "state.sqlite"));
  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          paused: store.get("pause:all") ?? false,
          repositories: config.repositories.map((r) => ({
            id: r.id,
            paused: store.get(`pause:${r.id}`) ?? false,
            health: store.get(`health:${r.id}`),
          })),
          jobs: store.jobs(),
          pendingSync: (store.get<unknown[]>("outbox") ?? []).length,
        },
        null,
        2,
      ),
    );
    store.close();
    return;
  }
  if (command === "pause" || command === "resume") {
    const repo = option("--repo", "all");
    if (repo !== "all" && !config.repositories.some((r) => r.id === repo))
      throw new Error(`Unknown repository ${repo}`);
    store.set(`pause:${repo}`, command === "pause");
    console.log(`${command}: ${repo} (active agents are not interrupted)`);
    store.close();
    return;
  }
  if (command === "retry") {
    const identifier = option("--issue", "");
    const jobs = store
      .jobs()
      .filter(
        (j) =>
          j.identifier === identifier &&
          ["execution", "review"].includes(j.role),
      );
    if (!jobs.length) throw new Error(`No job found for ${identifier}`);
    if (jobs.some((j) => j.status === "running"))
      throw new Error("Cannot retry an active job");
    const execution = jobs.find((j) => j.role === "execution");
    const job = execution ?? jobs[0];
    const repo = config.repositories.find((r) => r.id === job.repo)!;
    await linear.connect();
    try {
      await linear.updateIssue(job.issueId, {
        state: job.role === "execution" ? repo.states.todo : repo.states.review,
      });
      for (const j of jobs) {
        j.status = "waiting";
        j.fingerprint = undefined;
        store.save(j);
      }
      console.log(`Retry requested for ${identifier}`);
    } finally {
      await linear.close();
      store.close();
    }
    return;
  }
  if (command !== "run" && command !== "doctor")
    throw new Error(`Unknown command ${command}`);
  const lock = resolve(config.data_dir, "runner.lock");
  let ownsLock = false;
  if (command === "run") {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      ownsLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          `Runner already active (PID ${pid}); use the existing tmux process`,
        );
      unlinkSync(lock);
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      ownsLock = true;
    }
  }
  const runner = new CodexRunner({
    command: config.codex.command,
    args: config.codex.args,
    onEvent: (event) => {
      // Do not persist raw prompts, tool output, auth responses or stderr.
      const e = event as { method?: string; type?: string };
      if (e.method === "turn/completed") log("codex_turn_completed");
    },
  });
  let machine: Machine | undefined;
  let stop = false;
  let signals = 0;
  const onSignal = () => {
    signals++;
    stop = true;
    machine?.stop(signals > 1);
    console.log(
      signals === 1
        ? "Stopping new work; waiting for active agents. Ctrl+C again to interrupt."
        : "Interrupting active agents and preserving worktrees.",
    );
  };
  try {
    for (const executable of ["git", "gh"])
      execFileSync(executable, ["--version"], { stdio: "ignore" });
    for (const r of config.repositories) {
      execFileSync("git", ["-C", r.path, "rev-parse", "--show-toplevel"], {
        stdio: "ignore",
      });
      readFileSync(config.codex.workflow, "utf8");
    }
    await linear.connect();
    await runner.start();
    // Check the independent agent MCP configuration, not the Desktop session.
    const servers = await runner.mcpStatus();
    if (
      !servers.some(
        (s) => s.name === config.codex.linear_mcp_server && s.toolCount > 0,
      )
    )
      throw new Error(
        `Codex MCP server ${config.codex.linear_mcp_server} is unavailable. Run codex mcp add/login as documented.`,
      );
    if (command === "doctor") {
      for (const r of config.repositories)
        await linear.listIssues({
          team: r.team,
          project: r.project,
          state: r.states.todo,
        });
      console.log(
        "Ready: git/gh installed, Codex ChatGPT OAuth active, controller Linear MCP and Codex Linear MCP connected. No agent turn or repository mutation was started.",
      );
      return;
    }
    machine = new Machine(config, store, linear, runner, log);
    machine.recover();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let mtime = statSync(file).mtimeMs;
    let reloadError = "";
    while (!stop) {
      if (runner.failure)
        throw new Error(
          `Codex app-server unavailable: ${runner.failure}. Restart the runner to resume preserved work.`,
        );
      try {
        const next = statSync(file).mtimeMs;
        if (next !== mtime) {
          const updated = loadConfig(file);
          machine.reload(updated);
          config = updated;
          mtime = next;
          reloadError = "";
          log("config_reloaded");
        }
      } catch (e) {
        if (String(e) !== reloadError) {
          reloadError = String(e);
          log("config_reload_rejected", { error: reloadError });
        }
      }
      try {
        await machine.tick();
      } catch (error) {
        log("tick_error", { error: String(error) });
      }
      if (!stop) await sleep(1000);
    }
    await machine.drain();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    machine?.stop(true);
    await runner.close();
    try {
      await machine?.drain();
    } catch (error) {
      log("shutdown_sync_pending", { error: String(error) });
    }
    await linear.close();
    store.close();
    if (ownsLock) unlinkSync(lock);
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
