#!/usr/bin/env node
/**
 * Push the current submission text to the open vibeathon pull request.
 *
 * The entry lives in two places once it has been submitted: here, and on the branch the
 * pull request is built from. Keeping them in step by hand is exactly the sort of thing that
 * silently rots, so this does the whole round trip — pin the links to the newest commit,
 * copy the file across, commit, push — and then says what is left for a person to do.
 *
 * It cannot open or edit the pull request itself: that is a write to spokesz/..., which this
 * environment refuses. What it can do is update the branch, which GitHub picks up
 * automatically, so the DIFF is always current. The pull request DESCRIPTION is a separate
 * copy that GitHub never syncs, so that stays a manual paste — and this prints the reminder.
 *
 *   npm run submission:pr
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const FORK = process.env.RF_FORK_DIR ?? "/home/user/rarefriends-vibeathon";
const BRANCH = "submit-rare-agency";
const RELATIVE = "submissions/rare-agency/README.md";

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function must(condition, message) {
  if (!condition) { console.error(message); process.exit(1); }
}

// The fork has to be checked out somewhere for this to push from.
try { run(FORK, "rev-parse", "--git-dir"); }
catch {
  must(false, `No clone of the fork at ${FORK}.\n`
    + `Clone it first:  git clone https://github.com/Arithmos111/rarefriends-vibeathon ${FORK}\n`
    + `Or point RF_FORK_DIR at an existing clone.`);
}

// Never ship a submission built on uncommitted work: the links pin a commit, and a commit
// cannot describe changes that are still sitting in the working tree.
const dirty = run(root, "status", "--porcelain", "--", RELATIVE);
must(!dirty, `${RELATIVE} has uncommitted changes. Commit them first, so the pinned links point at them.`);

const dryRun = process.argv.includes("--dry-run");

console.log("Pinning the entry's links to the newest commit…");
execFileSync("node", [path.join(root, "scripts/stamp-submission.mjs")], { stdio: "inherit" });

// Re-pinning almost always rewrites the file, and that rewrite has to be committed before it
// can be pushed anywhere — so commit it here rather than making a person do it by hand. The
// pin then names the commit before this one, which is correct: that is the commit whose
// content the entry describes.
if (run(root, "status", "--porcelain", "--", RELATIVE)) {
  if (dryRun) {
    console.log(`\n--dry-run: would commit the re-pin, push it, and copy it onto ${BRANCH}.`);
    run(root, "checkout", "--", RELATIVE);
    process.exit(0);
  }
  console.log("Committing the re-pin…");
  run(root, "add", RELATIVE);
  run(root, "commit", "-m", "Re-pin the submission's links");
  run(root, "push", "origin", run(root, "rev-parse", "--abbrev-ref", "HEAD"));
}
if (dryRun) {
  console.log(`\n--dry-run: the entry is already pinned to the newest commit; nothing would change.`);
  process.exit(0);
}

const sha = run(root, "rev-parse", "HEAD");
must(run(root, "branch", "-r", "--contains", sha), `Commit ${sha.slice(0, 7)} is not pushed yet — push this repo first.`);

console.log(`Copying the entry onto ${BRANCH} in ${FORK}…`);
run(FORK, "fetch", "origin", BRANCH);
run(FORK, "checkout", "-B", BRANCH, `origin/${BRANCH}`);
await mkdir(path.join(FORK, path.dirname(RELATIVE)), { recursive: true });
await copyFile(path.join(root, RELATIVE), path.join(FORK, RELATIVE));

if (!run(FORK, "status", "--porcelain", "--", RELATIVE)) {
  console.log("\nThe pull request already carries this exact text. Nothing to push.");
  process.exit(0);
}

run(FORK, "add", RELATIVE);
run(FORK, "commit", "-m", `Update the submission to ${sha.slice(0, 7)}`);
run(FORK, "push", "origin", BRANCH);

const body = await readFile(path.join(root, RELATIVE), "utf8");
console.log(`\nPushed. The pull request's diff is now up to date.

One thing GitHub will NOT do for you: the pull request DESCRIPTION is a separate copy of this
text, and it does not follow the branch. To bring it in line:

  1. Open  https://github.com/spokesz/rarefriends-vibeathon/pull/33
  2. Click the ··· on the opening comment, then Edit
  3. Replace it with the ${body.split("\n").length} lines of ${RELATIVE}
     (raw: https://raw.githubusercontent.com/Arithmos111/rarefriends_spyvsspy/${sha}/${RELATIVE})
`);
