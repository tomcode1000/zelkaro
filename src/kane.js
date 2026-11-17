// Thin wrapper around `kane-cli run --agent`: runs one natural-language
// objective in a real Chrome and returns Kane's run_end record plus the path
// of the sealed evidence pack.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let resolved;
function kaneCommand() {
  if (resolved) return resolved;
  if (process.env.ZELKARO_KANE) return (resolved = { cmd: process.env.ZELKARO_KANE, pre: [] });
  // On Windows the npm shim is a .cmd/.ps1, which mangles quoted arguments.
  // Run the package's JS entry with node directly instead.
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const entry = path.join(root, '@testmuai', 'kane-cli', 'bin', 'kane-cli.cjs');
    if (fs.existsSync(entry)) return (resolved = { cmd: process.execPath, pre: [entry] });
  } catch {}
  return (resolved = { cmd: 'kane-cli', pre: [] });
}

/**
 * @param {string} objective  plain-English objective
 * @param {{url:string, variables?:object, maxSteps?:number, timeout?:number, headless?:boolean, log?:(s:string)=>void}} opts
 */
export async function runKane(objective, opts) {
  // Back-to-back runs can start while the previous run is still finalizing its
  // upload, and kane-cli then briefly reports an unconfigured project. Wait and
  // retry instead of recording a false "error".
  // Seen in practice: a burst of several failures in a row, so back off up to
  // ~9 minutes in total before giving up. Also pause briefly after every run.
  let authFails = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await runOnce(objective, opts);
    await sleep(5000);
    // An expired login fails every remaining run. Stop the scan and say so
    // instead of burning through the rest of the checks.
    // Token refresh sometimes fails on a network blip while the login is still
    // valid, so give it a few tries before declaring the login expired.
    if (!res.end && /token refresh failed|run: kane-cli login|not authenticated/i.test(res.stderr)) {
      authFails++;
      if (authFails <= 3) {
        opts.log?.(`kane token refresh failed, retrying in ${authFails * 30}s`);
        await sleep(authFails * 30000);
        attempt--;
        continue;
      }
      throw new KaneAuthError('Kane CLI login expired. Run `kane-cli login` (or `kane-cli login --username <u> --access-key <key>` for long runs), then run Zelkaro again.');
    }
    const transient = !res.end && /must be configured|lock/i.test(res.stderr);
    if (!transient || attempt >= 8) return res;
    opts.log?.(`kane not ready (transient), retrying in ${attempt * 15}s`);
    await sleep(attempt * 15000);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class KaneAuthError extends Error {}

function runOnce(objective, opts) {
  const { cmd, pre } = kaneCommand();
  const args = [...pre, 'run', objective, '--agent', '--url', opts.url,
    '--max-steps', String(opts.maxSteps ?? 25), '--timeout', String(opts.timeout ?? 360)];
  if (opts.headless !== false) args.push('--headless');
  if (opts.variables) args.push('--variables', JSON.stringify(opts.variables));

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let tail = '';
    child.stdout.on('data', (d) => {
      out += d;
      tail += d;
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.status === 'done' && ev.remark && opts.log) opts.log(ev.remark);
        } catch {}
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const events = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const end = events.findLast((e) => e.type === 'run_end') || null;
      const pack = (events.find((e) => e.pack)?.pack) || (err.match(/evidence serve (\S+\.evidence)/)?.[1]) || null;
      resolve({ code, end, pack, stderr: err.slice(-2000) });
    });
  });
}
