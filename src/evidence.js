// Pulls proof out of a Kane evidence pack: every step's summary and the
// screenshot of the decisive step (the failed assertion, or the last step).
import fs from 'node:fs';
import path from 'node:path';
import { readZip } from './zip.js';

/**
 * Auto-discovery: every same-origin GET the browser made during a Kane run
 * whose URL carries the record id or whose response contained the canary.
 * Kane records a HAR for every run, so this costs no extra runs and finds
 * background API calls the developer may have forgotten about.
 */
export function discoverRoutes(packPath, { origin, id, canary }) {
  const zip = readZip(packPath);
  const urls = new Map();
  for (const name of zip.names().filter((n) => n.endsWith('.har'))) {
    let har;
    try { har = JSON.parse(zip.read(name).toString('utf8')); } catch { continue; }
    for (const e of har?.log?.entries || []) {
      const url = e.request?.url || '';
      if (e.request?.method !== 'GET' || !url.startsWith(origin)) continue;
      const body = e.response?.content?.text || '';
      const hasId = id && new URL(url).pathname.split('/').includes(id);
      const hasCanary = body.includes(canary);
      if (hasId || hasCanary) urls.set(url.split('#')[0], { url, status: e.response?.status, sawCanary: hasCanary });
    }
  }
  return [...urls.values()];
}

export function readSteps(packPath) {
  const zip = readZip(packPath);
  const stepDirs = new Map();
  for (const name of zip.names()) {
    const m = name.match(/^(tests\/[^/]+\/steps\/(\d+)-[^/]+)\/(step\.json|screenshot\.jpg|annotated\.png)$/);
    if (!m) continue;
    const entry = stepDirs.get(m[1]) || { dir: m[1], ordinal: Number(m[2]), files: {} };
    entry.files[m[3]] = name;
    stepDirs.set(m[1], entry);
  }
  const steps = [...stepDirs.values()].sort((a, b) => a.ordinal - b.ordinal).map((s) => {
    let meta = {};
    try { meta = JSON.parse(zip.read(s.files['step.json']).toString('utf8')); } catch {}
    return { ...s, kind: meta.kind || '', status: meta.status || '', summary: meta.summary || '', url: meta.url || '' };
  });
  return { zip, steps };
}

/**
 * Copies the decisive screenshot(s) into outDir and returns their relative paths.
 * Picks: the first failed step (what Kane saw when it caught the leak), else the
 * last step with a screenshot (what Kane saw when the check passed).
 */
export function extractProof(packPath, outDir, prefix) {
  const { zip, steps } = readSteps(packPath);
  const withShot = steps.filter((s) => s.files['screenshot.jpg']);
  const failed = steps.find((s) => s.status === 'failed');
  const decisive = failed || steps.filter((s) => s.summary).at(-1);
  // The assert step itself may have no screenshot; use the latest frame Kane
  // captured at or before it, which is the page the assertion judged.
  const frame = decisive && withShot.filter((s) => s.ordinal <= decisive.ordinal).at(-1);
  const shots = [];
  fs.mkdirSync(outDir, { recursive: true });
  if (frame) {
    const file = `${prefix}.jpg`;
    fs.writeFileSync(path.join(outDir, file), zip.read(frame.files['screenshot.jpg']));
    shots.push({ file, step: decisive.summary, status: decisive.status, url: frame.url });
  }
  return { shots, steps: steps.filter((s) => s.summary).map((s) => ({ ordinal: s.ordinal, status: s.status, summary: s.summary })) };
}
