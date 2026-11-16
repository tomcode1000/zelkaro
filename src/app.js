// Optional app lifecycle. When zelkaro.config.json has "app": {"start", "healthUrl"},
// Zelkaro starts the app, restarts it after every agent fix (so code changes
// actually run before Kane re-checks), and stops it at the end.
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function appManager(cfg, cwd, log) {
  const app = cfg.app;
  let child = null;

  async function start() {
    if (!app?.start) return;
    if (await healthy(app.healthUrl)) {
      throw new Error(`Something is already serving ${app.healthUrl}. Stop it, or remove "app.start" from the config to test an app you run yourself.`);
    }
    log(`app: starting \`${app.start}\``);
    child = spawn(app.start, { cwd, shell: true, stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 60; i++) {
      if (await healthy(app.healthUrl)) return log('app: ready');
      if (child.exitCode !== null) throw new Error(`app exited with code ${child.exitCode} before becoming healthy`);
      await sleep(500);
    }
    throw new Error(`app did not become healthy at ${app.healthUrl} within 30s`);
  }

  async function stop() {
    if (!child) return;
    const pid = child.pid;
    child = null;
    // shell:true puts the app under a shell; kill the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { process.kill(-pid); } catch { try { process.kill(pid); } catch {} }
    for (let i = 0; i < 20 && (await healthy(app.healthUrl)); i++) await sleep(500);
  }

  return { start, stop, restart: async () => { await stop(); await start(); }, managed: Boolean(app?.start) };
}
