// One Zelkaro scan:
//   1. plant    - Kane signs in as the owner and creates a private record that
//                 holds a random canary. Kane reports its URL.
//   2. discover - Zelkaro reads the network log (HAR) from Kane's evidence pack
//                 and collects every same-origin GET that carried the record id
//                 or returned the canary, including background API calls.
//   3. probes   - Kane, as a second user and as a logged-out visitor, opens
//                 every discovered URL and asserts the canary is NOT there.
//   4. tamper   - Kane, as the second user, tries to overwrite the record.
//   5. control  - Kane, as the owner, confirms the record was not tampered with
//                 and the canary IS still visible. Denying everyone is not a fix.
// Every verdict comes from Kane running a real browser.
import crypto from 'node:crypto';
import path from 'node:path';
import { runKane } from './kane.js';
import { extractProof, discoverRoutes } from './evidence.js';

const OWNER = 'owner';
const INTRUDER = 'intruder';
const ANON = 'anonymous';

export function loginPhrase(cfg, actor) {
  if (actor === ANON) return 'Do not log in.';
  // Neutral variable names: Kane reads them, and a name like "intruder" makes
  // it second-guess which account it should be using.
  const key = actor === OWNER ? 'user_1' : 'user_2';
  const user = cfg.users[actor];
  // Prove the login worked before judging anything. Without this, a failed
  // login silently turns a "second user" probe into a logged-out probe, and a
  // leak that only signed-in users can reach would be reported as sealed.
  const proof = user.signedInCheck || `the page shows you are signed in as ${user.username}`;
  // Explicit step order: Kane once hoisted the check above the login itself.
  return `Step 1: on ${cfg.baseUrl}${cfg.loginPath}, type username ${user.username} and password {{${key}_password}} into the login form and submit it. Step 2: only after the form is submitted and the next page has loaded, verify that ${proof}. Step 3:`;
}

function variables(cfg) {
  return {
    user_1_password: { value: cfg.users.owner.password, secret: true },
    user_2_password: { value: cfg.users.intruder.password, secret: true },
  };
}

const idOf = (url) => (new URL(url).pathname.match(/([A-Za-z0-9_-]+)\/?$/) || [])[1] || '';

export function expandUrl(template, planted) {
  const u = new URL(planted);
  return template.replaceAll('{url}', planted).replaceAll('{origin}', u.origin).replaceAll('{id}', idOf(planted));
}

export function findUrl(end, origin) {
  const state = { ...(end?.final_state || {}) };
  for (const [k, v] of Object.entries(end?.context?.variables || {})) state[k] = v?.value;
  const values = Object.entries(state).filter(([, v]) => typeof v === 'string' && v.startsWith(origin));
  // Prefer an explicitly extracted value over the browser's final URL.
  const pick = values.find(([k]) => k !== 'url') || values[0];
  return pick?.[1] || null;
}

// Which assertion failed decides the verdict, so a failed sign-in check is
// never mistaken for a leak.
export function failedAssert(steps, end) {
  const step = steps.find((s) => s.status === 'failed' && /^assert/i.test(s.summary));
  return step ? step.summary : String(end?.reason || '');
}

function noResult(res) {
  return { verdict: 'error', detail: 'Kane produced no result: ' + res.stderr.split('\n').filter(Boolean).slice(-2).join(' ') };
}

export function readVerdict(res, canary, steps) {
  const end = res.end;
  if (!end) return noResult(res);
  if (end.status === 'passed') return { verdict: 'blocked', detail: end.one_liner || end.summary };
  if (String(end.reason_code || '').startsWith('assertion_error')) {
    if (failedAssert(steps, end).includes(canary)) return { verdict: 'leak', detail: end.one_liner || end.reason };
    return { verdict: 'inconclusive', detail: `sign-in check failed, so this probe proves nothing: ${end.one_liner || end.reason}` };
  }
  return { verdict: 'inconclusive', detail: `${end.reason_code}: ${end.one_liner || end.reason}` };
}

export function ownerVerdict(res, canary, tamperToken, steps) {
  const end = res.end;
  if (!end) return { owner: noResult(res), tamper: tamperToken ? 'inconclusive' : null };
  if (end.status === 'passed') return { owner: { verdict: 'ok', detail: end.one_liner || end.summary }, tamper: tamperToken ? 'blocked' : null };
  const failed = failedAssert(steps, end);
  if (String(end.reason_code || '').startsWith('assertion_error')) {
    if (tamperToken && failed.includes(tamperToken)) return { owner: { verdict: 'ok', detail: 'owner signed in and opened the record' }, tamper: 'tampered', detail: end.one_liner || end.reason };
    if (failed.includes(canary)) return { owner: { verdict: 'owner-locked-out', detail: end.one_liner || end.reason }, tamper: tamperToken ? 'blocked' : null };
  }
  return { owner: { verdict: 'inconclusive', detail: `${end.reason_code}: ${end.one_liner || end.reason}` }, tamper: tamperToken ? 'inconclusive' : null };
}

/**
 * @param {object} cfg   parsed zelkaro.config.json
 * @param {{outDir:string, label:string, log:(s:string)=>void}} ctx
 */
export async function scan(cfg, ctx) {
  const log = ctx.log;
  const hex = () => crypto.randomBytes(4).toString('hex');
  const canary = 'CANARY-' + hex();
  const tamperToken = cfg.tamper ? 'TAMPERED-' + hex() : null;
  const vars = variables(cfg);
  const shotDir = path.join(ctx.outDir, 'screenshots');
  const origin = new URL(cfg.baseUrl).origin;
  const loginUrl = cfg.baseUrl + cfg.loginPath;
  const result = { label: ctx.label, canary, tamperToken, startedAt: new Date().toISOString(), plantedUrl: null, discovered: [], checks: [], credits: 0 };
  let n = 0;
  // A Kane run that crashed (no run_end, or an infra_error such as the browser
  // closing) tells us nothing either way. Retry it up to twice.
  const crashed = (res) => !res.end || String(res.end.reason_code || '').startsWith('infra_error');
  const kane = async (objective, url) => {
    let res;
    for (let i = 0; i < 3; i++) {
      if (i) log(`  kane run crashed (${res.end?.reason_code || 'no result'}), retrying`);
      res = await runKane(objective, { url, variables: vars, log: (s) => log('  kane> ' + s) });
      result.credits += res.end?.credits_consumed || 0;
      if (!crashed(res)) break;
    }
    return res;
  };
  const proofOf = (res, id) => (res.pack ? extractProof(res.pack, shotDir, `${ctx.label}-${n++}-${id.replace(/[^a-z0-9-]+/gi, '_')}`) : { shots: [], steps: [] });

  // 1. Plant
  log(`plant: Kane signs in as the owner and creates a private ${cfg.resource} holding ${canary}`);
  const plantObjective = `${loginPhrase(cfg, OWNER)} ${cfg.plant.replaceAll('{canary}', canary)} Then store the full URL of the page that shows the saved ${cfg.resource} as {{planted_url}}.`;
  let plant = await kane(plantObjective, loginUrl);
  let planted = findUrl(plant.end, origin);
  if (!planted) {
    log('plant: no URL came back, retrying once');
    plant = await kane(plantObjective, loginUrl);
    planted = findUrl(plant.end, origin);
  }
  result.checks.push({ id: 'plant', actor: OWNER, target: planted, expect: 'creates', verdict: planted ? 'ok' : 'error',
    detail: plant.end?.one_liner || 'no result', proof: proofOf(plant, 'plant'), testUrl: plant.end?.test_url || null });
  if (!planted) {
    result.error = 'Kane could not plant the canary, so nothing was tested.';
    return finish(result);
  }
  result.plantedUrl = planted;
  log(`plant: ${planted}`);

  // 2. Discover
  const targets = new Map(); // key -> {url, how}
  const add = (url, how) => { if (!targets.has(url)) targets.set(url, { url, how }); };
  add(planted, 'planted page');
  if (cfg.autoDiscover !== false && plant.pack) {
    for (const r of discoverRoutes(plant.pack, { origin, id: idOf(planted), canary })) {
      add(r.url, r.sawCanary ? 'discovered: response contained the canary' : 'discovered: URL carries the record id');
      result.discovered.push(r);
    }
    log(`discover: Kane's network log shows ${result.discovered.length} route(s) touching the record: ${result.discovered.map((r) => new URL(r.url).pathname).join(', ') || 'none'}`);
  }
  for (const p of cfg.probes || []) add(expandUrl(p.url, planted), 'configured');

  // 3. Read probes
  for (const t of targets.values()) {
    for (const actor of [INTRUDER, ANON]) {
      const id = `${actor}:${new URL(t.url).pathname}`;
      log(`${id}: Kane as ${actor} opens ${t.url}`);
      const objective = `${loginPhrase(cfg, actor)} Then go to ${t.url} . Verify that the text '${canary}' is NOT visible anywhere on the page.`;
      let res = await kane(objective, actor === ANON ? t.url : loginUrl);
      let proof = proofOf(res, id);
      let v = readVerdict(res, canary, proof.steps);
      if (v.verdict === 'inconclusive') {
        // One retry: a flaky sign-in should not cost a verdict.
        log(`${id}: inconclusive (${v.detail}), retrying once`);
        res = await kane(objective, actor === ANON ? t.url : loginUrl);
        proof = proofOf(res, id);
        v = readVerdict(res, canary, proof.steps);
      }
      result.checks.push({ id, kind: 'read', actor, target: t.url, how: t.how, expect: 'hidden', ...v, proof, testUrl: res.end?.test_url || null });
      log(`${id}: ${v.verdict.toUpperCase()} - ${v.detail}`);
    }
  }

  // 4. Tamper attempt
  let tamperCheck = null;
  if (cfg.tamper) {
    const target = expandUrl(cfg.tamper.url, planted);
    const id = `${INTRUDER}:tamper`;
    log(`${id}: Kane as ${INTRUDER} tries to overwrite the ${cfg.resource} at ${target}`);
    const action = cfg.tamper.action.replaceAll('{tamper}', tamperToken);
    const res = await kane(`${loginPhrase(cfg, INTRUDER)} Then go to ${target} . If a form to change the ${cfg.resource} is shown: ${action} If you get an error or a not-found page instead, stop there.`, loginUrl);
    // If the attack itself never finished, the owner seeing an untouched record
    // proves nothing: it must not be reported as "blocked".
    tamperCheck = { id, kind: 'tamper', actor: INTRUDER, target, how: 'configured', expect: 'unchanged', verdict: 'pending', ran: !crashed(res), detail: res.end?.one_liner || 'no result', proof: proofOf(res, id), testUrl: res.end?.test_url || null };
    result.checks.push(tamperCheck);
  }

  // 5. Owner control (also judges the tamper attempt)
  log(`owner-control: Kane as ${OWNER} opens ${planted}`);
  const ownerAsserts = (tamperToken ? `Verify that the text '${tamperToken}' is NOT visible anywhere on the page. ` : '') + `Verify that the text '${canary}' IS visible on the page.`;
  const ownerObjective = `${loginPhrase(cfg, OWNER)} Then go to ${planted} . ${ownerAsserts}`;
  let ownerRes = await kane(ownerObjective, loginUrl);
  let ownerProof = proofOf(ownerRes, 'owner-control');
  let ov = ownerVerdict(ownerRes, canary, tamperToken, ownerProof.steps);
  if (ov.owner.verdict === 'inconclusive') {
    log(`owner-control: inconclusive (${ov.owner.detail}), retrying once`);
    ownerRes = await kane(ownerObjective, loginUrl);
    ownerProof = proofOf(ownerRes, 'owner-control');
    ov = ownerVerdict(ownerRes, canary, tamperToken, ownerProof.steps);
  }
  result.checks.push({ id: 'owner-control', kind: 'control', actor: OWNER, target: planted, expect: 'visible', ...ov.owner, proof: ownerProof, testUrl: ownerRes.end?.test_url || null });
  log(`owner-control: ${ov.owner.verdict.toUpperCase()} - ${ov.owner.detail}`);
  if (tamperCheck) {
    tamperCheck.verdict = ov.tamper === 'blocked' && !tamperCheck.ran ? 'inconclusive' : ov.tamper;
    if (tamperCheck.verdict === 'inconclusive' && !tamperCheck.ran) tamperCheck.detail = `Kane's tamper attempt crashed before finishing, so this proves nothing: ${tamperCheck.detail}`;
    if (ov.tamper === 'tampered') tamperCheck.detail = `the owner's ${cfg.resource} now shows ${tamperToken}: ${ov.detail}`;
    log(`${tamperCheck.id}: ${String(ov.tamper).toUpperCase()} - ${tamperCheck.detail}`);
  }
  return finish(result);
}

function finish(result) {
  result.finishedAt = new Date().toISOString();
  result.leaks = result.checks.filter((c) => c.verdict === 'leak' || c.verdict === 'tampered');
  result.problems = result.checks.filter((c) => ['owner-locked-out', 'inconclusive', 'error'].includes(c.verdict));
  result.status = result.error ? 'error' : result.leaks.length ? 'leaking' : result.problems.length ? 'inconclusive' : 'sealed';
  return result;
}
