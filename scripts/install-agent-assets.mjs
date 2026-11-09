#!/usr/bin/env node
import { lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function existing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function install(args) {
  const dryRun = args[0] === "--dry-run";
  if (dryRun) args = args.slice(1);
  if (args[0] === "--help") {
    console.log(
      "Usage: node scripts/install-agent-assets.mjs [--dry-run] [home-directory]",
    );
    return;
  }
  if (args.length > 1 || args[0]?.startsWith("-"))
    throw new Error(
      "Usage: node scripts/install-agent-assets.mjs [--dry-run] [home-directory]",
    );

  const home = resolve(args[0] ?? homedir());
  const source = fileURLToPath(new URL("../agents/", import.meta.url));
  const root = join(home, ".agents");
  const directories = [root, join(root, "skills"), join(root, "workflows")];
  const links = [
    ...["symphony-intake", "symphony-execute"].map((name) => ({
      source: join(source, "skills", name),
      destination: join(root, "skills", name),
      directory: true,
    })),
    ...["WORKFLOW.md", "LINEAR-CONTRACT.md"].map((name) => ({
      source: join(source, "workflows", name),
      destination: join(root, "workflows", name),
      directory: false,
    })),
  ];

  // Check every destination before creating anything, including linked parents.
  for (const directory of directories) {
    const item = existing(directory);
    if (item && (!item.isDirectory() || item.isSymbolicLink()))
      throw new Error(
        `Expected a real directory: ${directory}. See the README migration instructions.`,
      );
  }
  for (const link of links) {
    const sourceItem = lstatSync(link.source);
    if (link.directory ? !sourceItem.isDirectory() : !sourceItem.isFile())
      throw new Error(`Invalid source: ${link.source}`);
    const item = existing(link.destination);
    if (!item) continue;
    if (
      !item.isSymbolicLink() ||
      realpathSync(link.destination) !== realpathSync(link.source)
    )
      throw new Error(
        `Destination already exists with different content: ${link.destination}`,
      );
    link.installed = true;
  }

  for (const directory of directories) {
    if (existing(directory)) continue;
    if (dryRun) console.log(`Would create directory: ${directory}`);
    else mkdirSync(directory, { recursive: true });
  }
  for (const link of links) {
    if (link.installed) {
      console.log(`Already linked: ${link.destination}`);
      continue;
    }
    if (dryRun)
      console.log(`Would link: ${link.destination} -> ${link.source}`);
    else {
      symlinkSync(
        link.source,
        link.destination,
        link.directory
          ? process.platform === "win32"
            ? "junction"
            : "dir"
          : "file",
      );
      console.log(`Linked: ${link.destination} -> ${link.source}`);
    }
  }
}

try {
  install(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
