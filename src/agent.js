// Hands Kane's findings to a coding agent and lets it patch the app.
// Default agent: Claude Code in print mode. Any agent that reads a prompt on
// stdin works: set "agent.command" in crossleak.config.json.
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';

export function buildFixPrompt(cfg, result, outDir) {
  const lines = result.leaks.map((c) => {
    const shot = c.proof.shots[0] ? path.join(outDir, 'screenshots', c.proof.shots[0].file) : 'n/a';
    return `- ${c.id}: as ${c.actor}, Kane opened ${c.target} and saw the owner's secret "${result.canary}". Kane said: "${c.detail}". Screenshot: ${shot}`;
  });
  return `Kane CLI (a real-browser test agent) just found cross-user data leaks in this app.

The owner (${cfg.users.owner.username}) created a private ${cfg.resource} at ${result.plantedUrl} containing the canary "${result.canary}".
Other people could read it:
${lines.join('\n')}

Fix the access control so a ${cfg.resource} can only be read by its owner, on every route listed above (pages and API).
Rules:
- The owner must still be able to read their own ${cfg.resource}. Kane re-checks this, so denying everyone fails.
- Fix the root cause in the authorization logic. Do not hide content with CSS or rename routes.
- Do not edit crossleak.config.json, the canary, or anything under crossleak-report/.
${cfg.agent?.hint ? `- Hint from the project: ${cfg.agent.hint}\n` : ''}
When done, reply with two sentences: what was wrong and what you changed.`;
}

export function runAgent(cfg, prompt, cwd, log) {
  const command = cfg.agent?.command || 'claude -p --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep"';
  log(`agent: ${command}`);
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, reply: out.trim(), stderr: err.trim() }));
    child.stdin.end(prompt);
  });
}

export function gitDiff(cwd) {
  try {
    return execSync('git --no-pager diff --no-color -- . ":(exclude)crossleak-report"', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}
