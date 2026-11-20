// src/result.ts
import { lstatSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var environment = (raw) => {
  if (!raw || typeof raw !== "object")
    return;
  const text = (v) => typeof v === "string" ? v.replace(ANSI, "").replace(/[^\w .,:+()/-]/g, "").slice(0, 80) : "";
  return {
    commit: /^[0-9a-f]{7,40}$/.test(raw.commit) ? raw.commit : "",
    app: text(raw.app),
    podman: text(raw.podman),
    image: text(raw.image),
    settings: text(raw.settings),
    rvp: text(raw.rvp),
    minutes: Number.isInteger(raw.minutes) && raw.minutes >= 0 && raw.minutes < 1e4 ? raw.minutes : 0
  };
};
var lines = (list, max, length) => (Array.isArray(list) ? list : []).filter((s) => typeof s === "string").slice(0, max).map((s) => s.replace(ANSI, "").slice(0, length));
var observed = (list) => (Array.isArray(list) ? list : []).filter((o) => typeof o?.line === "string" && typeof o.step === "string").slice(0, 2).map((o) => ({ line: o.line.replace(ANSI, "").slice(0, 240), step: o.step.replace(ANSI, "").slice(0, 120) }));
var MEDIA = /^media\/[\w.-]+\.png$/;
var MAX_CHECKS = 50;
var MAX_BYTES = 10 * 1024 * 1024;
var ANSI = /\x1b\[[0-9;]*m/g;
var IDS = /\s*(?:[[(](?:id=)?(?:f\d+)?e\d+(?:-(?:f\d+)?e\d+)?[\])]|\bid=(?:f\d+)?e\d+\b|\b(?:f\d+)?e\d{2,}(?:-(?:f\d+)?e\d+)?\b)/g;
var withoutIds = (text) => text.replace(IDS, "");
function outcome(checks) {
  const passed = checks.filter((c) => c.status === "passed").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  if (passed + failed === 0)
    return "no_result";
  return failed === 0 ? "pass" : passed === 0 ? "fail" : "mixed";
}
var read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return;
  }
};
function finish(outDir, env) {
  let checks = [];
  try {
    checks = JSON.parse(read(join(outDir, "checks.json")) ?? "[]").filter((c) => typeof c?.claim === "string" && ["passed", "failed", "skipped"].includes(c.status)).slice(0, MAX_CHECKS).map((c) => ({
      claim: c.claim.slice(0, 300),
      status: c.status,
      ...typeof c.reason === "string" ? { reason: c.reason.replace(ANSI, "").slice(0, 2000) } : {},
      screenshots: (Array.isArray(c.screenshots) ? c.screenshots : []).filter((f) => typeof f === "string" && MEDIA.test(f)),
      ...Array.isArray(c.observed) && c.observed.length ? { observed: observed(c.observed) } : {},
      ...Array.isArray(c.steps) && c.steps.length ? { steps: lines(c.steps, 8, 120) } : {},
      ...Array.isArray(c.seen) ? { seen: seen(c.seen) } : {}
    }));
  } catch {}
  const notes = read(join(outDir, "notes.md")) ?? (checks.length ? "" : `No check was produced. End of the agent log:
${(read(join(outDir, "agent.log")) ?? "").slice(-1500)}`);
  const result = {
    pr: Number(env.RVP_PR),
    repo: env.RVP_REPO ?? "",
    runner: env.RVP_RUNNER ?? "",
    model: env.RVP_MODEL ?? "",
    instruction: env.RVP_INSTRUCTION ?? "",
    outcome: outcome(checks),
    checks,
    notes: withoutIds(notes.replace(ANSI, "")).slice(0, 4000),
    ...(() => {
      try {
        const env = environment(JSON.parse(read(join(outDir, "environment.json")) ?? "null"));
        return env ? { environment: env } : {};
      } catch {
        return {};
      }
    })(),
    facts: ["speed.txt", "looked.txt"].flatMap((file) => (read(join(outDir, file)) ?? "").split(`
`).filter((line) => line.trim()).slice(0, 1)).map((line) => line.replace(ANSI, "").slice(0, 200))
  };
  writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
var seen = (list) => list.filter((s) => typeof s?.file === "string" && MEDIA.test(s.file) && typeof s.says === "string").slice(0, 8).map((s) => ({ file: s.file, shows: s.shows === true, says: s.says.replace(ANSI, "").slice(0, 300) }));

// src/finish.ts
var result = finish(process.argv[2], process.env);
console.log(`outcome: ${result.outcome} (${result.checks.length} checks)`);
