/** Every dream is one git commit, so nothing is ever truly lost and each night can be reviewed or reverted. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IDENT = ["-c", "user.name=Dream", "-c", "user.email=dream@localhost", "-c", "commit.gpgsign=false"];

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...IDENT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function ensureRepo(root: string): boolean {
  if (!hasGit()) return false;
  if (!fs.existsSync(path.join(root, ".git"))) git(root, ["init", "-q", "-b", "main"]);
  return true;
}

/** Commit everything that changed. Returns the short hash, or undefined when nothing changed. */
export function commitAll(root: string, message: string): string | undefined {
  if (!ensureRepo(root)) return undefined;
  git(root, ["add", "-A"]);
  const status = git(root, ["status", "--porcelain"]);
  if (!status.trim()) return undefined;
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "--short", "HEAD"]).trim();
}

/** The last few dream commits, newest first: hash, date, subject. */
export function dreamHistory(root: string, n = 10): string[] {
  if (!hasGit() || !fs.existsSync(path.join(root, ".git"))) return [];
  try {
    return git(root, ["log", `-${n}`, "--format=%h %ad %s", "--date=short"]).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
