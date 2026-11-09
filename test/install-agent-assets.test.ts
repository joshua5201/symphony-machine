import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(
  new URL("../scripts/install-agent-assets.mjs", import.meta.url),
);
const assets = fileURLToPath(new URL("../agents/", import.meta.url));

function home(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "symphony install "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function install(directory: string, ...args: string[]) {
  return execFileSync(process.execPath, [installer, ...args, directory], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("agent installation previews without writes and keeps other skills and workflows on repeated installs", (t) => {
  const directory = home(t);
  install(directory, "--dry-run");
  const root = join(directory, ".agents");
  assert.equal(existsSync(root), false);
  mkdirSync(join(root, "skills", "other"), { recursive: true });
  mkdirSync(join(root, "workflows"));
  writeFileSync(join(root, "skills", "other", "SKILL.md"), "Other skill");
  writeFileSync(join(root, "workflows", "other.md"), "Other workflow");

  install(directory);
  install(directory);
  assert.equal(lstatSync(root).isSymbolicLink(), false);
  for (const name of ["symphony-intake", "symphony-execute"]) {
    const skill = join(root, "skills", name);
    assert.equal(
      realpathSync(skill),
      realpathSync(join(assets, "skills", name)),
    );
    // Both the checkout and installed skill paths resolve the same workflow.
    assert.equal(
      readFileSync(join(skill, "../../workflows/WORKFLOW.md"), "utf8"),
      readFileSync(join(root, "workflows/WORKFLOW.md"), "utf8"),
    );
  }
  for (const name of ["WORKFLOW.md", "LINEAR-CONTRACT.md"])
    assert.equal(
      realpathSync(join(root, "workflows", name)),
      realpathSync(join(assets, "workflows", name)),
    );
  assert.equal(
    readFileSync(join(root, "skills", "other", "SKILL.md"), "utf8"),
    "Other skill",
  );
  assert.equal(
    readFileSync(join(root, "workflows", "other.md"), "utf8"),
    "Other workflow",
  );
});

test("an installation conflict preserves existing content and creates no earlier links", (t) => {
  const directory = home(t);
  const root = join(directory, ".agents");
  const conflict = join(root, "skills", "symphony-execute");
  mkdirSync(conflict, { recursive: true });
  writeFileSync(join(conflict, "SKILL.md"), "Local work");
  assert.throws(
    () => install(directory),
    /Destination already exists with different content/,
  );
  assert.equal(readFileSync(join(conflict, "SKILL.md"), "utf8"), "Local work");
  assert.equal(existsSync(join(root, "skills", "symphony-intake")), false);
  assert.equal(existsSync(join(root, "workflows")), false);
});

test("installation refuses a whole-tree link instead of writing into another repository", (t) => {
  const directory = home(t);
  const legacy = join(directory, "legacy-assets");
  mkdirSync(legacy);
  symlinkSync(
    legacy,
    join(directory, ".agents"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => install(directory), /Expected a real directory/);
  assert.equal(realpathSync(join(directory, ".agents")), realpathSync(legacy));
  assert.equal(existsSync(join(legacy, "skills")), false);
});
