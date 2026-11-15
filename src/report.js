// Writes the human-readable proof: REPORT.md with every Kane verdict, the
// screenshot Kane took at the decisive step, the agent's patch, and a badge.
import fs from 'node:fs';
import path from 'node:path';

const ICON = { ok: '✅', blocked: '✅', leak: '🔴', tampered: '🔴', 'owner-locked-out': '⚠️', inconclusive: '❔', error: '❌', pending: '❔' };
const WORD = { ok: 'OK', blocked: 'Blocked', leak: 'LEAK', tampered: 'TAMPERED', 'owner-locked-out': 'Owner locked out', inconclusive: 'Inconclusive', error: 'Error', pending: 'Pending' };

function badge(status) {
  const [label, color] = status === 'sealed' ? ['sealed', '#2da44e'] : status === 'leaking' ? ['leaking', '#cf222e'] : ['inconclusive', '#9a6700'];
  const w = 70 + label.length * 7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w + 62}" height="20" role="img" aria-label="zelkaro: ${label}">
<rect width="62" height="20" fill="#555"/><rect x="62" width="${w}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14">zelkaro</text><text x="68" y="14">${label} · Kane CLI</text></g></svg>`;
}

function roundMd(r) {
  const rows = r.checks.map((c) => `| ${c.id} | ${c.actor} | \`${c.target || '-'}\` | ${c.how || '-'} | ${c.expect} | ${ICON[c.verdict] || ''} ${WORD[c.verdict] || c.verdict} | ${c.testUrl ? `[Kane run](${c.testUrl})` : '-'} |`);
  const disc = (r.discovered || []).map((d) => `- \`${d.url}\` (HTTP ${d.status}${d.sawCanary ? ', response contained the canary' : ''})`).join('\n');
  const shots = r.checks.filter((c) => c.proof.shots[0]).map((c) => {
    const s = c.proof.shots[0];
    return `#### ${ICON[c.verdict] || ''} ${c.id} (${c.actor})\n> Kane: ${c.detail}\n\n> Decisive step: \`${s.step}\` (${s.status})\n\n![${c.id}](screenshots/${s.file})\n`;
  });
  return `### ${r.label}: ${r.status.toUpperCase()}
Canary \`${r.canary}\`${r.tamperToken ? ` · tamper token \`${r.tamperToken}\`` : ''} · planted at \`${r.plantedUrl || '-'}\` · ${r.checks.length} Kane runs · ${r.credits.toFixed(0)} credits
${disc ? `
**Routes auto-discovered from Kane's network log during the plant run:**
${disc}
` : ''}
| Check | Actor | URL | Found by | Record should be | Kane verdict | Evidence |
|---|---|---|---|---|---|---|
${rows.join('\n')}

${shots.join('\n')}`;
}

export function writeReport(outDir, run) {
  fs.mkdirSync(outDir, { recursive: true });
  const final = run.rounds.at(-1);
  fs.writeFileSync(path.join(outDir, 'badge.svg'), badge(final.status));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(run, null, 2));

  const fixes = (run.fixes || []).map((f, i) => `### Fix ${i + 1} by ${f.agent}
> ${f.reply.split('\n').join('\n> ')}

\`\`\`diff
${f.diff.trim() || '(no diff captured)'}
\`\`\`
`).join('\n');

  const md = `# Zelkaro report

![zelkaro](badge.svg)

**Target:** ${run.baseUrl} · **Final status:** ${final.status.toUpperCase()} · **Rounds:** ${run.rounds.length} · **Kane credits:** ${run.rounds.reduce((a, r) => a + r.credits, 0).toFixed(0)}

Every verdict below came from Kane CLI driving a real Chrome. The screenshots are the frames Kane captured at the step that decided the verdict, taken from its sealed evidence packs.

## How to read this
- **plant**: Kane signs in as the owner and creates a private ${run.resource} holding a random canary.
- **owner-control**: the owner must still see their own data, or a "fix" that blocks everyone would pass.
- **discovered routes**: every page and background API call Kane's browser made that carried the record's id or returned the canary. Zelkaro reads them from the HAR in Kane's evidence pack, so nobody has to list routes by hand.
- **intruder / anonymous rows**: another user or a logged-out visitor tries to read each route. ✅ Blocked is good. 🔴 LEAK means Kane saw the canary.
- **intruder:tamper**: the other user tries to overwrite the record. 🔴 TAMPERED means the owner later saw the attacker's text.

## Rounds
${run.rounds.map(roundMd).join('\n---\n')}
${fixes ? `\n## Agent fixes\n${fixes}` : ''}
`;
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), md);
  return path.join(outDir, 'REPORT.md');
}
