import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitConfig, loadConfig } from "../src/config.js";

test("worktrees default inside each repository while explicit roots retain config-relative resolution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const explicitRoot = join(directory, "external-worktrees");
  await writeFile(
    configPath,
    JSON.stringify({
      data_dir: "runtime-data",
      repositories: [
        {
          id: "default",
          path: "projects/default",
          github: "demo/default",
          team: "Demo",
          project: "Default",
        },
        {
          id: "relative",
          path: "projects/relative",
          github: "demo/relative",
          team: "Demo",
          project: "Relative",
          worktree_root: "custom-worktrees",
          states: { ready_to_merge: "Merge queue" },
          concurrency: { execution_tickets: 1, reviews: 2 },
        },
        {
          id: "absolute",
          path: "projects/absolute",
          github: "demo/absolute",
          team: "Demo",
          project: "Absolute",
          worktree_root: explicitRoot,
          concurrency: { maintenance_scans: 2 },
        },
      ],
    }),
  );
  const config = loadConfig(configPath);
  assert.deepEqual(config.merge, {
    group_interval_minutes: 30,
    cooldown_minutes: 5,
  });
  const [defaultRepo, relativeRepo, absoluteRepo] = config.repositories;
  assert.equal(defaultRepo.path, join(directory, "projects", "default"));
  assert.equal(
    defaultRepo.worktree_root,
    join(defaultRepo.path, ".symphony", "worktrees"),
  );
  assert.equal(gitConfig(defaultRepo).worktreeRoot, defaultRepo.worktree_root);
  assert.equal(relativeRepo.worktree_root, join(directory, "custom-worktrees"));
  assert.equal(absoluteRepo.worktree_root, explicitRoot);
  assert.equal(config.data_dir, join(directory, "runtime-data"));
  assert.equal(defaultRepo.states.ready_to_merge, "Ready to merge");
  assert.equal(relativeRepo.states.ready_to_merge, "Merge queue");
  assert.equal(relativeRepo.states.review, "In Review");
  assert.deepEqual(defaultRepo.concurrency, {
    execution_tickets: 3,
    reviews: 1,
    maintenance_scans: 1,
  });
  assert.deepEqual(relativeRepo.concurrency, {
    execution_tickets: 1,
    reviews: 2,
    maintenance_scans: 1,
  });
  assert.deepEqual(absoluteRepo.concurrency, {
    execution_tickets: 3,
    reviews: 1,
    maintenance_scans: 2,
  });
  await writeFile(
    configPath,
    `merge:\n  group_interval_minutes: 15\n  cooldown_minutes: 2\nrepositories:\n  - id: app\n    path: .\n    github: demo/app\n    team: Demo\n    project: App\n`,
  );
  assert.deepEqual(loadConfig(configPath).merge, {
    group_interval_minutes: 15,
    cooldown_minutes: 2,
  });
});
