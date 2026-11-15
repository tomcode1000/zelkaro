#!/usr/bin/env node
// zelkaro scan   - Kane tries to read one user's data as other people
// zelkaro heal   - scan, hand leaks to your coding agent, re-scan until sealed
import fs from 'node:fs';
import path from 'node:path';
import { scan } from '../src/scan.js';
import { buildFixPrompt, runAgent, gitDiff } from '../src/agent.js';
import { writeReport } from '../src/report.js';

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

scan  exits 0 when sealed, 1 when Kane saw a leak, 2 when inconclusive.
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

fs.rmSync(outDir, { recursive: true, force: true });
const run = { tool: 'zelkaro', baseUrl: cfg.baseUrl, resource: cfg.resource, startedAt: new Date().toISOString(), rounds: [], fixes: [] };

async function main() {
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
    const res = await runAgent(cfg, prompt, cwd, log);
    const diff = gitDiff(cwd);
    run.fixes.push({ round, agent: cfg.agent?.name || 'Claude Code', prompt, reply: res.reply || res.stderr || `(agent exited ${res.code})`, diff });
    log(`agent: ${res.reply.split('\n').slice(-3).join(' ')}`);
    writeReport(outDir, run);
  }
  run.finishedAt = new Date().toISOString();
  const report = writeReport(outDir, run);
  const final = run.rounds.at(-1);
  if (json) console.log(JSON.stringify({ status: final.status, leaks: final.leaks.map((l) => ({ id: l.id, actor: l.actor, target: l.target, kane: l.detail })), report }, null, 2));
  else log(`\nReport: ${report}`);
  process.exit(final.status === 'sealed' ? 0 : final.status === 'leaking' ? 1 : 2);
}

main().catch((e) => { console.error(e); process.exit(3); });
