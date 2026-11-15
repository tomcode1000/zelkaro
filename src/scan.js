// One Zelkaro scan:
//   1. plant   - Kane logs in as the owner and creates a private item that
//                contains a random canary token. Kane reports its URL.
//   2. control - Kane, as the owner, confirms the canary IS visible. This keeps
//                a "fix" honest: denying everyone is not a fix.
//   3. probes  - Kane, as another user and as a logged-out visitor, opens the
//                item's page and API URLs and asserts the canary is NOT there.
// Every verdict comes from Kane running a real browser.
import crypto from 'node:crypto';
import path from 'node:path';
import { runKane } from './kane.js';
import { extractProof } from './evidence.js';

const ACTORS = { owner: 'owner', intruder: 'intruder', anonymous: 'anonymous' };

function loginPhrase(cfg, actor) {
  if (actor === ACTORS.anonymous) return 'Do not log in.';
  // Variable names are neutral (user_1/user_2): Kane reads them, and a name
  // like "intruder" makes it second-guess which account it should be using.
  const key = actor === ACTORS.owner ? 'user_1' : 'user_2';
  const user = cfg.users[actor];
  // Prove the login worked before judging anything. Without this, a failed
  // login silently turns a "second user" probe into a logged-out probe, and a
  // leak that only signed-in users can reach would be reported as sealed.
  const proof = user.signedInCheck || `the page shows you are signed in as ${user.username}`;
  return `Log in at ${cfg.baseUrl}${cfg.loginPath} with username ${user.username} and password {{${key}_password}}. Verify that ${proof}.`;
}

function variables(cfg) {
  return {
    user_1_password: { value: cfg.users.owner.password, secret: true },
    user_2_password: { value: cfg.users.intruder.password, secret: true },
  };
}

export function expandUrl(template, planted) {
  const u = new URL(planted);
  const id = (u.pathname.match(/([A-Za-z0-9_-]+)\/?$/) || [])[1] || '';
  return template.replaceAll('{url}', planted).replaceAll('{origin}', u.origin).replaceAll('{id}', id);
}

function findUrl(end, origin) {
  const state = { ...(end?.final_state || {}) };
  for (const [k, v] of Object.entries(end?.context?.variables || {})) state[k] = v?.value;
  const values = Object.entries(state).filter(([, v]) => typeof v === 'string' && v.startsWith(origin));
  // Prefer an explicitly extracted value over the browser's final URL.
  const pick = values.find(([k]) => k !== 'url') || values[0];
  return pick?.[1] || null;
}

function verdictOf(res, expectVisible, canary, steps) {
  const end = res.end;
  if (!end) return { verdict: 'error', detail: 'Kane produced no result: ' + res.stderr.split('\n').filter(Boolean).slice(-2).join(' ') };
  if (end.status === 'passed') return { verdict: expectVisible ? 'ok' : 'blocked', detail: end.one_liner || end.summary };
  if (String(end.reason_code || '').startsWith('assertion_error')) {
    // Only the canary assertion decides leak / locked-out. If the sign-in
    // assertion failed instead, the probe never ran as the right person.
    const failed = steps.find((s) => s.status === 'failed' && /^assert/i.test(s.summary));
    const aboutCanary = failed ? failed.summary.includes(canary) : String(end.reason || '').includes(canary);
    if (aboutCanary) return { verdict: expectVisible ? 'owner-locked-out' : 'leak', detail: end.one_liner || end.reason };
    return { verdict: 'inconclusive', detail: `sign-in check failed, so this probe proves nothing: ${end.one_liner || end.reason}` };
  }
  return { verdict: 'inconclusive', detail: `${end.reason_code}: ${end.one_liner || end.reason}` };
}

/**
 * @param {object} cfg   parsed zelkaro.config.json
 * @param {{outDir:string, label:string, log:(s:string)=>void}} ctx
 */
export async function scan(cfg, ctx) {
  const log = ctx.log;
  const canary = 'CANARY-' + crypto.randomBytes(4).toString('hex');
  const vars = variables(cfg);
  const shotDir = path.join(ctx.outDir, 'screenshots');
  const result = { label: ctx.label, canary, startedAt: new Date().toISOString(), plantedUrl: null, checks: [], credits: 0 };
  const loginUrl = cfg.baseUrl + cfg.loginPath;

  // 1. Plant
  log(`plant: Kane signs in as the owner and creates a private ${cfg.resource} holding ${canary}`);
  const plantObjective = `${loginPhrase(cfg, ACTORS.owner)} ${cfg.plant.replaceAll('{canary}', canary)} Then store the full URL of the page that shows the saved ${cfg.resource} as {{planted_url}}.`;
  const plant = await runKane(plantObjective, { url: loginUrl, variables: vars, log: (s) => log('  kane> ' + s) });
  result.credits += plant.end?.credits_consumed || 0;
  const planted = findUrl(plant.end, new URL(cfg.baseUrl).origin);
  const plantProof = plant.pack ? extractProof(plant.pack, shotDir, `${ctx.label}-0-plant`) : { shots: [], steps: [] };
  result.checks.push({ id: 'plant', actor: 'owner', target: planted, expect: 'creates', verdict: planted ? 'ok' : 'error',
    detail: plant.end?.one_liner || 'no result', proof: plantProof, testUrl: plant.end?.test_url || null });
  if (!planted) {
    result.error = 'Kane could not plant the canary, so nothing was tested.';
    return finish(result);
  }
  result.plantedUrl = planted;
  log(`plant: ${planted}`);

  // 2. Control + 3. Probes
  const checks = [{ id: 'owner-control', actor: ACTORS.owner, url: '{url}', expectVisible: true }, ...cfg.probes.map((p) => ({ ...p, expectVisible: false }))];
  let n = 1;
  for (const c of checks) {
    const target = expandUrl(c.url, planted);
    const verb = c.expectVisible ? 'IS visible' : 'is NOT visible anywhere';
    log(`${c.id}: Kane as ${c.actor} opens ${target}`);
    const objective = `${loginPhrase(cfg, c.actor)} Then go to ${target} . Verify that the text '${canary}' ${verb} on the page.`;
    const res = await runKane(objective, { url: c.actor === ACTORS.anonymous ? target : loginUrl, variables: vars, log: (s) => log('  kane> ' + s) });
    result.credits += res.end?.credits_consumed || 0;
    const proof = res.pack ? extractProof(res.pack, shotDir, `${ctx.label}-${n++}-${c.id}`) : { shots: [], steps: [] };
    const v = verdictOf(res, c.expectVisible, canary, proof.steps);
    result.checks.push({ id: c.id, actor: c.actor, target, expect: c.expectVisible ? 'visible' : 'hidden', ...v, proof, testUrl: res.end?.test_url || null });
    log(`${c.id}: ${v.verdict.toUpperCase()} - ${v.detail}`);
  }
  return finish(result);
}

function finish(result) {
  result.finishedAt = new Date().toISOString();
  result.leaks = result.checks.filter((c) => c.verdict === 'leak');
  result.problems = result.checks.filter((c) => ['owner-locked-out', 'inconclusive', 'error'].includes(c.verdict));
  result.status = result.error ? 'error' : result.leaks.length ? 'leaking' : result.problems.length ? 'inconclusive' : 'sealed';
  return result;
}
