/**
 * Experiment 16: does the bot's own severity label track correctness?
 *
 * The model tags each finding critical, warning, or info. If that label carried
 * signal, the critical findings would be the most likely to be real. This script
 * computes the false-positive rate per severity from two sources, with no model
 * calls:
 *   - the 83 hand-scored findings (Experiment 8), the ground truth;
 *   - the 200-PR large-scale run (Experiment 15), judge-scored, for scale.
 *
 * It writes eval/eval-severity.json and docs/severity.svg, and prints the table.
 * Run: npx tsx eval/severity-eval.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEVS = ['critical', 'warning', 'info'] as const;
type Sev = (typeof SEVS)[number];

function rateByset(
  rows: Array<{ severity: string; fp: boolean }>,
): Record<Sev, { n: number; fp: number }> {
  const out = { critical: { n: 0, fp: 0 }, warning: { n: 0, fp: 0 }, info: { n: 0, fp: 0 } };
  for (const r of rows) {
    if (r.severity in out) {
      const s = out[r.severity as Sev];
      s.n += 1;
      if (r.fp) s.fp += 1;
    }
  }
  return out;
}

// Ground truth: the 83 hand-scored findings (severity + hand truth label).
const hand = readFileSync(resolve(process.cwd(), 'eval/eval-gate-full-audit.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .map((r) => ({ severity: r.severity as string, fp: r.truth === 'false_positive' }));

// Scale: the 200-PR run, judge-scored (only rows with per-finding detail).
const scale: Array<{ severity: string; fp: boolean }> = [];
for (const l of readFileSync(resolve(process.cwd(), 'eval/eval-largescale.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)) {
  for (const f of JSON.parse(l).judged ?? [])
    scale.push({ severity: f.severity, fp: f.verdict === 'false_positive' });
}

const handR = rateByset(hand);
const scaleR = rateByset(scale);

console.log("False-positive rate by the bot's own severity label\n");
console.log('severity   hand-labeled (ground truth)     200-PR (judge-scored)');
for (const s of SEVS) {
  const h = handR[s];
  const c = scaleR[s];
  console.log(
    `${s.padEnd(9)}  ${h.fp}/${h.n} = ${h.n ? Math.round((h.fp / h.n) * 100) : 0}%`.padEnd(46) +
      `${c.fp}/${c.n} = ${c.n ? Math.round((c.fp / c.n) * 100) : 0}%`,
  );
}
const critN = handR.critical.n + scaleR.critical.n;
const critFp = handR.critical.fp + scaleR.critical.fp;
console.log(
  `\nAcross both sets, findings the bot marked "critical": ${critFp}/${critN} were false positives.`,
);

writeFileSync(
  resolve(process.cwd(), 'eval/eval-severity.json'),
  `${JSON.stringify({ hand: handR, scale: scaleR }, null, 2)}\n`,
  'utf8',
);

// --- chart: grouped bars, FP rate per severity, hand-labeled vs scale ---
const X0 = 70;
const X1 = 470;
const Y0 = 300;
const Y1 = 66;
const py = (v: number): number => +(Y0 + (Y1 - Y0) * v).toFixed(1);
const HAND = '#1d4ed8';
const SCALE = '#60a5fa';
const INK = '#1e293b';
const p: string[] = [];
p.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 380" font-family="-apple-system,Segoe UI,Roboto,sans-serif">`,
);
p.push(`<rect x="0" y="0" width="520" height="380" fill="#ffffff" stroke="#e2e8f0"/>`);
p.push(
  `<text x="260" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="${INK}">False positives by the bot's own severity label</text>`,
);
p.push(
  `<text x="260" y="44" text-anchor="middle" font-size="11" fill="#64748b">if severity carried signal, critical would be the lowest bar, not the highest</text>`,
);
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  p.push(`<line x1="${X0}" y1="${py(t)}" x2="${X1}" y2="${py(t)}" stroke="#f1f5f9"/>`);
  p.push(
    `<text x="${X0 - 8}" y="${py(t) + 4}" text-anchor="end" font-size="10" fill="${INK}">${t * 100}%</text>`,
  );
}
const groupW = (X1 - X0) / SEVS.length;
const bw = 46;
SEVS.forEach((s, i) => {
  const cx = X0 + groupW * (i + 0.5);
  const h = handR[s];
  const c = scaleR[s];
  const hr = h.n ? h.fp / h.n : 0;
  const cr = c.n ? c.fp / c.n : 0;
  p.push(
    `<rect x="${cx - bw - 2}" y="${py(hr)}" width="${bw}" height="${+(Y0 - py(hr)).toFixed(1)}" fill="${HAND}"/>`,
  );
  p.push(
    `<rect x="${cx + 2}" y="${py(cr)}" width="${bw}" height="${+(Y0 - py(cr)).toFixed(1)}" fill="${SCALE}"/>`,
  );
  p.push(
    `<text x="${cx - bw / 2 - 2}" y="${py(hr) - 5}" text-anchor="middle" font-size="10" fill="${INK}">${Math.round(hr * 100)}%</text>`,
  );
  p.push(
    `<text x="${cx + bw / 2 + 2}" y="${py(cr) - 5}" text-anchor="middle" font-size="10" fill="${INK}">${Math.round(cr * 100)}%</text>`,
  );
  p.push(
    `<text x="${cx}" y="${Y0 + 16}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${INK}">${s}</text>`,
  );
  p.push(
    `<text x="${cx}" y="${Y0 + 30}" text-anchor="middle" font-size="9" fill="#64748b">n=${h.n} hand / ${c.n} scale</text>`,
  );
});
p.push(
  `<text x="22" y="175" text-anchor="middle" font-size="11" fill="${INK}" transform="rotate(-90 22 175)">false-positive rate</text>`,
);
const ly = 355;
p.push(`<rect x="150" y="${ly - 9}" width="11" height="11" fill="${HAND}"/>`);
p.push(`<text x="166" y="${ly}" font-size="10.5" fill="${INK}">hand-labeled (83)</text>`);
p.push(`<rect x="300" y="${ly - 9}" width="11" height="11" fill="${SCALE}"/>`);
p.push(`<text x="316" y="${ly}" font-size="10.5" fill="${INK}">200-PR judge-scored</text>`);
p.push('</svg>');
writeFileSync(resolve(process.cwd(), 'docs/severity.svg'), `${p.join('\n')}\n`, 'utf8');
console.log('-> eval/eval-severity.json, docs/severity.svg');
