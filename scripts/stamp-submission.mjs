#!/usr/bin/env node
/**
 * Pin the submission's links to an immutable commit.
 *
 * The submission README links to the source at a specific revision, so a judge reads exactly
 * what was entered rather than whatever the branch has drifted to since. Those links start as
 * the literal placeholder below, which is the one thing in the document that cannot be caught
 * by proofreading: it looks fine and every link 404s.
 *
 * So: run this, and it rewrites the placeholder to a real commit and prints the links to
 * check. Run it again before opening the pull request to re-pin to the final commit; it
 * accepts an already-stamped file and re-stamps it, so it is safe to repeat.
 *
 *   npm run submission            # pin to HEAD
 *   npm run submission -- <ref>   # pin to any ref, e.g. a tag or an older commit
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = path.join(root, "submissions/rare-agency/README.md");
const PLACEHOLDER = "REPLACE_SHA";
const REPO = "https://github.com/Arithmos111/rarefriends_spyvsspy";
/**
 * The two places a revision of THIS repository appears, matching either the placeholder or a
 * sha already stamped in, so re-stamping works.
 *
 * Deliberately narrow. The document also pins FriendSDK's own commit, which is a 40-character
 * hex string like any other: a blanket search-and-replace rewrites that too and quietly
 * misattributes the SDK. Only a link into this repository, or the checkout line, is ours.
 */
const revision = String.raw`(?:${PLACEHOLDER}|[0-9a-f]{40})`;
const RAW = "https://raw.githubusercontent.com/Arithmos111/rarefriends_spyvsspy";
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TARGETS = [
  new RegExp(String.raw`(${escape(REPO)}/(?:tree|blob)/)${revision}`, "g"),
  // The screenshot must be an absolute raw-content URL rather than a repository-relative
  // path: this README is pasted verbatim into the pull request body, where a relative path
  // renders as a broken image.
  new RegExp(String.raw`(${escape(RAW)}/)${revision}`, "g"),
  new RegExp(String.raw`(git checkout )${revision}`, "g"),
];

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const ref = process.argv[2] ?? "HEAD";
let sha;
try {
  sha = git("rev-parse", ref);
} catch {
  console.error(`Not a revision this repository knows: ${ref}`);
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error(`Expected a full commit sha, got: ${sha}`);
  process.exit(1);
}

const before = await readFile(file, "utf8");
const after = TARGETS.reduce((text, pattern) => text.replace(pattern, `$1${sha}`), before);
if (after.includes(PLACEHOLDER)) {
  console.error(`Left an unstamped ${PLACEHOLDER} behind — a link this script does not know about.`);
  process.exit(1);
}
if (after === before) {
  console.log(`Already pinned to ${sha}. Nothing to do.`);
} else {
  await writeFile(file, after);
  console.log(`Pinned ${path.relative(root, file)} to ${sha}.`);
}

// Print every link that depends on the pin, so they can be opened and checked by eye.
const links = [...new Set(
  after.match(/https:\/\/(?:raw\.githubusercontent|github)\.com\/\S*?\/[0-9a-f]{40}[^\s)]*/g) ?? [])];
console.log(`\n${links.length} pinned ${links.length === 1 ? "link" : "links"}:`);
for (const link of links) console.log(`  ${link}`);

// A commit nobody else can fetch makes every one of those links a 404.
let pushed = false;
try {
  pushed = git("branch", "-r", "--contains", sha).length > 0;
} catch { /* a shallow clone cannot answer; say so rather than guess. */ }
console.log(pushed
  ? "\nThis commit is on a remote branch, so the links resolve."
  : "\nThis commit is not on any remote branch yet — push before the links will resolve.");
