#!/usr/bin/env node
// zelkaro scan   - Kane tries to read one user's data as other people
// zelkaro heal   - scan, hand leaks to your coding agent, re-scan until sealed
import fs from 'node:fs';
import path from 'node:path';
import { scan } from '../src/scan.js';
import { buildFixPrompt, runAgent, gitDiff } from '../src/agent.js';
import { writeReport } from '../src/report.js';
import { appManager } from '../src/app.js';
import { KaneAuthError } from '../src/kane.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

if (!cmd || cmd === '--help' || cmd === '-h' || !['scan', 'heal'].includes(cmd)) {
  console.log(`zelkaro: find cross-user data leaks with Kane CLI, fix them with your coding agent, prove the fix.

Usage:
  zelkaro scan [--config zelkaro.config.json] [--out zelkaro-report] [--json]
  zelkaro heal [--config zelkaro.config.json] [--out zelkaro-report] [--max-rounds 3]

scan  exits 0 when sealed, 1 when Kane saw a leak, 2 when inconclusive, 4 when the Kane login expired.
heal  loops scan -> agent fix -> scan until Kane proves no leaks (or max rounds).

Requires kane-cli (npm i -g @testmuai/kane-cli) and \`kane-cli login\`.`);
  process.exit(cmd ? 2 : 0);
}

const cwd = process.cwd();
const cfgPath = path.resolve(flag('config', 'zelkaro.config.json'));
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.loginPath ??= '/login';
cfg.resource ??= 'item';
const outDir = path.resolve(flag('out', 'zelkaro-report'));
const json = has('json');
const log = (s) => { if (!json) console.log(s); else process.stderr.write(s + '\n'); };

// Only ever delete a folder that is clearly a previous Zelkaro report.
function clearReportDir(dir) {
  if (!fs.existsSync(dir)) return;
  const rel = path.relative(dir, cwd);
  const isCwdOrParent = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  const entries = fs.readdirSync(dir);
  const looksLikeReport = entries.length === 0 || entries.includes('report.json') || entries.includes('.zelkaro-report');
  if (isCwdOrParent || entries.includes('.git') || !looksLikeReport) {
    console.error(`zelkaro: refusing to clear ${dir}: it is not a previous Zelkaro report folder. Pick another --out.`);
    process.exit(3);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
clearReportDir(outDir);
// Mark the folder as ours right away, so a run that is cut off mid-scan can still be cleared next time.
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '.zelkaro-report'), '');

// Files the coding agent must not touch: the config (it defines what "sealed"
// means) plus anything listed in agent.protect. Changes are reverted and
// recorded, so an agent cannot pass by editing the test.
function listFiles(p) {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p).flatMap((e) => listFiles(path.join(p, e)));
}
function snapshot() {
  const roots = [cfgPath, ...(cfg.agent?.protect || []).map((p) => path.resolve(p))];
  return new Map(roots.flatMap(listFiles).map((f) => [f, fs.readFileSync(f)]));
}
function restoreTampered(before) {
  const after = snapshot();
  const touched = [];
  for (const [f, buf] of before) if (!after.has(f) || !after.get(f).equals(buf)) { fs.writeFileSync(f, buf); touched.push(path.relative(cwd, f)); }
  for (const f of after.keys()) if (!before.has(f)) { fs.rmSync(f); touched.push(path.relative(cwd, f)); }
  return touched;
}
const run = { tool: 'zelkaro', baseUrl: cfg.baseUrl, resource: cfg.resource, startedAt: new Date().toISOString(), rounds: [], fixes: [] };

const app = appManager(cfg, cwd, (s) => log(s));

async function main() {
  await app.start();
  const maxRounds = cmd === 'heal' ? Number(flag('max-rounds', 3)) : 1;
  for (let round = 1; round <= maxRounds; round++) {
    log(`\n=== Round ${round}: Kane scan of ${cfg.baseUrl}`);
    const result = await scan(cfg, { outDir, label: `round-${round}`, log });
    run.rounds.push(result);
    writeReport(outDir, run);
    log(`=== Round ${round}: ${result.status.toUpperCase()} (${result.leaks.length} leak(s), ${result.problems.length} problem(s))`);

    if (result.status !== 'leaking' || cmd !== 'heal' || round === maxRounds) break;

    log(`\n=== Handing ${result.leaks.length} leak(s) to the coding agent`);
    const prompt = buildFixPrompt(cfg, result, outDir);
    const guarded = snapshot();
    const res = await runAgent(cfg, prompt, cwd, log);
    const tampered = restoreTampered(guarded);
    if (tampered.length) log(`agent edited protected files, reverted: ${tampered.join(', ')}`);
    const diff = gitDiff(cwd);
    run.fixes.push({ round, agent: cfg.agent?.name || 'Claude Code', prompt, reply: res.reply || res.stderr || `(agent exited ${res.code})`, diff, tampered });
    log(`agent: ${res.reply.split('\n').slice(-3).join(' ')}`);
    writeReport(outDir, run);
    // The agent may have changed server code that only loads at startup.
    if (app.managed) await app.restart();
    else log('note: if the agent changed code your app only loads at startup, restart the app (or set "app.start" in the config so Zelkaro does it).');
  }
  await app.stop();
  run.finishedAt = new Date().toISOString();
  const report = writeReport(outDir, run);
  const final = run.rounds.at(-1);
  if (json) console.log(JSON.stringify({ status: final.status, leaks: final.leaks.map((l) => ({ id: l.id, actor: l.actor, target: l.target, kane: l.detail })), report }, null, 2));
  else log(`\nReport: ${report}`);
  process.exit(final.status === 'sealed' ? 0 : final.status === 'leaking' ? 1 : 2);
}

main().catch(async (e) => {
  await app.stop().catch(() => {});
  if (run.rounds.length) writeReport(outDir, run);
  if (e instanceof KaneAuthError) { console.error(`\nzelkaro: ${e.message}`); process.exit(4); }
  console.error(e);
  process.exit(3);
});
