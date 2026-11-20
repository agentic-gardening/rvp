// src/comment.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { basename, join as join2 } from "node:path";

// src/result.ts
import { lstatSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var MEDIA = /^media\/[\w.-]+\.png$/;
var MAX_CHECKS = 50;
var MAX_MEDIA = 40;
var MAX_BYTES = 10 * 1024 * 1024;
var ANSI = /\x1b\[[0-9;]*m/g;
var seen = (list) => list.filter((s) => typeof s?.file === "string" && MEDIA.test(s.file) && typeof s.says === "string").slice(0, 8).map((s) => ({ file: s.file, shows: s.shows === true, says: s.says.replace(ANSI, "").slice(0, 300) }));
var PNG = [137, 80, 78, 71];
function checkMedia(outDir, rel) {
  if (typeof rel !== "string" || !MEDIA.test(rel))
    throw new Error(`bad media path: ${String(rel)}`);
  const path = join(outDir, rel);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error(`bad media file: ${rel}`);
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  readSync(fd, head, 0, 4, 0);
  closeSync(fd);
  if (!PNG.every((byte, i) => head[i] === byte))
    throw new Error(`not a png: ${rel}`);
  return rel;
}
function check(outDir) {
  const raw = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
  const str = (v, name) => {
    if (typeof v !== "string")
      throw new Error(`${name} must be a string`);
    return v;
  };
  if (!["pass", "fail", "mixed", "no_result"].includes(raw.outcome))
    throw new Error("bad outcome");
  if (!Array.isArray(raw.checks) || raw.checks.length > MAX_CHECKS)
    throw new Error("bad checks");
  let mediaCount = 0;
  const checks = raw.checks.map((c) => {
    if (!["passed", "failed", "skipped"].includes(c.status))
      throw new Error("bad check status");
    if (!Array.isArray(c.screenshots))
      throw new Error("bad screenshots");
    const screenshots = c.screenshots.map((s) => checkMedia(outDir, s));
    mediaCount += screenshots.length;
    return {
      claim: str(c.claim, "claim"),
      status: c.status,
      ...c.reason === undefined ? {} : { reason: str(c.reason, "reason") },
      screenshots,
      ...Array.isArray(c.seen) ? { seen: seen(c.seen).filter((s) => screenshots.includes(s.file)) } : {}
    };
  });
  if (mediaCount > MAX_MEDIA)
    throw new Error(`too many media files (${mediaCount} > ${MAX_MEDIA})`);
  return {
    pr: Number(raw.pr),
    repo: str(raw.repo, "repo"),
    runner: str(raw.runner, "runner"),
    model: str(raw.model, "model"),
    instruction: str(raw.instruction, "instruction"),
    outcome: raw.outcome,
    checks,
    notes: str(raw.notes, "notes"),
    ...Array.isArray(raw.facts) ? { facts: raw.facts.filter((f) => typeof f === "string").slice(0, 4) } : {}
  };
}

// src/comment.ts
var ICON = { passed: "✅", failed: "❌", skipped: "⚠️" };
var verdict = (result) => {
  const count = (status) => result.checks.filter((c) => c.status === status).length;
  const [passed, failed, skipped, all] = [count("passed"), count("failed"), count("skipped"), result.checks.length];
  if (failed)
    return `❌ **Not verified**: ${failed} of ${all} claim${all > 1 ? "s" : ""} ${failed > 1 ? "do" : "does"} not hold.`;
  if (!passed)
    return "⚠️ **Not checked**: the model gave no verdict.";
  if (skipped)
    return `⚠️ **Partially verified**: ${passed} of ${all} claims hold, ${skipped} could not be checked.`;
  return `✅ **Verified**: ${all === 1 ? "the claim holds" : `${all} of ${all} claims hold`}.`;
};
var strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
var inline = (s, max = 300) => strip(s).replace(/\s+/g, " ").slice(0, max).replace(/[\\`*_[\]#|!~>]/g, "\\$&").replace(/</g, "&lt;").replace(/@/g, "@​");
var block = (s, max, lang = "") => `~~~~${lang}
${strip(s).slice(0, max).replace(/~~~/g, "~~ ~")}
~~~~`;
function render(result, url, runUrl, actions, plan = "") {
  const overall = verdict(result);
  const out = [
    `## rvp: ${overall.split(":")[0].replace(/\*\*/g, "")}`,
    "",
    `Checked on ${inline(result.runner, 30)} with the build of this pull request running, by \`${inline(result.model, 60)}\`.`,
    "",
    `> ${inline(result.instruction, 600)}`
  ];
  const skipped = [];
  result.checks.forEach((c, i) => {
    if (c.status === "skipped") {
      skipped.push(`- ${inline(c.claim)}${c.reason ? `: ${inline(c.reason, 300)}` : ""}`, ...folded(groups(c.screenshots), url));
      return;
    }
    out.push("", `**${i + 1}. ${inline(c.claim)}** ${ICON[c.status]}`);
    if (c.reason)
      out.push("", inline(c.reason, 600));
    out.push(...pictures(c, url));
  });
  if (skipped.length)
    out.push("", "**Not checked:**", "", ...skipped);
  out.push("", "### Verdict", overall, ...result.checks.map((c) => `- ${ICON[c.status]} ${inline(c.claim)}`));
  if (plan.trim())
    out.push("", "<details><summary>What the agent planned</summary>", "", block(plan, 3000), "", "</details>");
  if (result.notes.trim())
    out.push("", "<details><summary>Agent notes</summary>", "", block(result.notes, 3000), "", "</details>");
  const steps = actions.split(`
`).filter((line) => line.trim()).slice(0, 80);
  if (steps.length)
    out.push("", `<details><summary>What the agent did (${steps.length} steps)</summary>`, "", ...steps.map((step, i) => `${i + 1}. ${inline(step, 300)}`), "", "</details>");
  const run = /\/runs\/(\d+)/.exec(runUrl)?.[1];
  out.push("", "---", `<sub>rvp · runner \`${inline(result.runner, 30)}\` · model \`${inline(result.model, 60)}\`${runUrl ? ` · [run ${run ?? ""} and result folder](${runUrl})` : ""}${(result.facts ?? []).map((fact) => ` · ${inline(fact, 200)}`).join("")}</sub>`, "<sub>A local model drove a build of this pull request and recorded these verdicts itself. They are its judgement, not a proof: check the screenshots and the action log before relying on them.</sub>");
  return out.join(`
`).slice(0, 60000);
}
function groups(files) {
  const found = new Map;
  for (const file of files) {
    const [, stem, dark] = /^(.*?)(\.dark)?\.png$/.exec(basename(file)) ?? [];
    if (!stem)
      continue;
    found.set(stem, { ...found.get(stem) ?? { stem, caption: inline(stem.replace(/^\d+-/, "").replace(/-/g, " ")) }, [dark ? "Dark" : "Light"]: file });
  }
  return [...found.values()];
}
function folded(list, url, summary = `${list.length} screenshot${list.length > 1 ? "s" : ""}`) {
  if (!list.length)
    return [];
  return ["", `<details><summary>${summary}</summary>`, ...screenshots(list.flatMap((g) => [g.Light, g.Dark].filter((f) => !!f)), url), "", "</details>"];
}
function pictures(c, url) {
  const all = groups(c.screenshots);
  if (!all.length)
    return [];
  const yes = c.seen?.find((s) => s.shows);
  const main = all.find((g) => g.Light === yes?.file) ?? all.at(-1);
  const first = main.Light ?? main.Dark;
  const says = yes?.file === first ? yes.says : undefined;
  const out = ["", `![${main.caption}](${url(first)})`, `<sub>${main.caption}${says ? ` · the model, looking at this picture: “${inline(says, 300)}”` : ""}</sub>`];
  const rest = all.filter((g) => g !== main);
  const twin = main.Light && main.Dark ? [{ ...main, Light: undefined }] : [];
  const more = [...twin, ...rest];
  const summary = [twin.length ? "Dark theme" : "", rest.length ? `${rest.length} more screenshot${rest.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
  return [...out, ...folded(more, url, summary)];
}
function screenshots(files, url) {
  const out = [];
  for (const group of groups(files)) {
    const { caption } = group;
    const columns = ["Light", "Dark"].filter((column) => group[column]);
    const image = (column) => `![${caption}](${url(group[column])})`;
    if (columns.length === 1)
      out.push("", image(columns[0]), `<sub>${caption}${columns[0] === "Dark" ? " (dark theme)" : ""}</sub>`);
    else
      out.push("", `<sub>${caption}</sub>`, "", `| ${columns.join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, `| ${columns.map(image).join(" | ")} |`);
  }
  return out;
}
var readText = (dir, file) => {
  try {
    return readFileSync2(join2(dir, file), "utf8");
  } catch {
    return "";
  }
};
async function api(token, method, path, body) {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "rvp" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok)
    throw Object.assign(new Error(`${method} ${path}: ${response.status} ${await response.text()}`), { status: response.status });
  return response.json();
}
async function uploadScreenshots(token, repo, dir, files, runId) {
  const urls = new Map;
  if (!files.length)
    return urls;
  try {
    await api(token, "GET", `/repos/${repo}/git/ref/heads/media`);
  } catch (error) {
    if (error.status !== 404)
      throw error;
    const { default_branch } = await api(token, "GET", `/repos/${repo}`);
    const head = await api(token, "GET", `/repos/${repo}/git/ref/heads/${default_branch}`);
    await api(token, "POST", `/repos/${repo}/git/refs`, { ref: "refs/heads/media", sha: head.object.sha });
  }
  for (const file of files) {
    const saved = await api(token, "PUT", `/repos/${repo}/contents/${runId}/${basename(file)}`, {
      message: `rvp run ${runId}: ${basename(file)}`,
      branch: "media",
      content: readFileSync2(join2(dir, file)).toString("base64")
    });
    urls.set(file, saved.content.download_url);
  }
  return urls;
}
async function main() {
  const dry = process.argv[2] === "--dry-run";
  const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] ?? "";
  const dir = dry ? process.argv[3] : input("dir");
  const result = check(dir);
  const actions = readText(dir, "steps.log");
  const plan = readText(dir, "plan.md");
  if (dry) {
    const prefix = process.argv[4];
    console.log(render(result, (media) => prefix ? prefix + basename(media) : media, "", actions, plan));
    return;
  }
  const { GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  const repo = input("repo");
  const pr = Number(input("pr"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0)
    throw new Error("bad repo or pr input");
  const urls = await uploadScreenshots(input("media_token"), GITHUB_REPOSITORY, dir, result.checks.flatMap((c) => c.screenshots), GITHUB_RUN_ID);
  const body = render(result, (media) => urls.get(media), `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`, actions, plan);
  const comment = await api(input("token"), "POST", `/repos/${repo}/issues/${pr}/comments`, { body });
  console.log(`commented: ${comment.html_url}`);
}
if (!process.env.BUN_TEST) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
export {
  block,
  inline,
  render,
  screenshots
};
