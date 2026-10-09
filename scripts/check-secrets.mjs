// Fails if any env file could be committed. Run via `pnpm check:secrets` and the pre-commit hook.
import { execFileSync } from "node:child_process";

const mustBeIgnored = [".env", ".env.local", ".env.production", "apps/web/.env", "packages/core/.env"];
const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch (err) {
    return err.status === 1 ? "" : (() => { throw err; })();
  }
};

const problems = [];

const ignored = new Set(git("check-ignore", ...mustBeIgnored).split("\n").filter(Boolean));
for (const p of mustBeIgnored) {
  if (!ignored.has(p)) problems.push(`${p} is NOT covered by .gitignore`);
}

const tracked = git("ls-files").split("\n").filter(Boolean);
for (const f of tracked) {
  const base = f.split("/").pop() ?? f;
  if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") problems.push(`${f} is tracked by git`);
}

if (problems.length > 0) {
  console.error(`check-secrets FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("check-secrets: ok (.env files are ignored and untracked)");
