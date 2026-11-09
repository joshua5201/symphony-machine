import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("dashboard defaults to loopback in the foreground runner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-dashboard-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    repositories: [{ id: "demo", path: ".", github: "demo/repo", team: "Demo", project: "Project" }],
  }));
  assert.deepEqual(loadConfig(configPath).dashboard, {
    enabled: true, host: "127.0.0.1", port: 4310,
  });
});

test("dashboard bind and port are read from local configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "symphony-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({
    dashboard: { enabled: false, host: "0.0.0.0", port: 4321 },
    repositories: [{ id: "demo", path: ".", github: "demo/repo", team: "Demo", project: "Project" }],
  }));
  assert.deepEqual(loadConfig(configPath).dashboard, {
    enabled: false,
    host: "0.0.0.0",
    port: 4321,
  });
});
