/**
 * Reliability diagram (Experiment 10 visual).
 *
 * Reads eval/eval-calibration.json and emits docs/reliability.svg: the model
 * self-reported confidence on the x-axis, the actual fraction of findings that
 * were real on the y-axis, the 45-degree perfect-calibration line, and one bar
 * per confidence bin with the gap to that line shaded. A well-calibrated model
 * sits on the diagonal. This one hugs the bottom, so its confidence carries
 * almost no information about whether a finding is real.
 *
 * Hand-built SVG, no charting library, renders directly on GitHub.
 * Run: npx tsx eval/reliability-diagram.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Bin {
  bin: string;
  count: number;
  meanConfidence: number | null;
  accuracy: number | null;
}
interface Calibration {
  strict: {
    ece: number;
    brier: number;
    meanConfidence: number;
    accuracy: number;
    reliability: Bin[];
  };
}

const cal: Calibration = JSON.parse(
  readFileSync(resolve(process.cwd(), 'eval/eval-calibration.json'), 'utf8'),
);
const S = cal.strict;
const bins = S.reliability.filter(
  (b): b is Bin & { meanConfidence: number; accuracy: number } => b.count > 0,
);

// Plot geometry. Data (0,0) maps to (X0,Y0); data (1,1) maps to (X1,Y1).
const X0 = 86;
const X1 = 446;
const Y0 = 392;
const Y1 = 40;
const px = (x: number): number => +(X0 + (X1 - X0) * x).toFixed(1);
const py = (y: number): number => +(Y0 + (Y1 - Y0) * y).toFixed(1);

const BLUE = '#2563eb';
const RED = '#dc2626';
const GRAY = '#94a3b8';
const INK = '#1e293b';

const p: string[] = [];
p.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 502" font-family="-apple-system,Segoe UI,Roboto,sans-serif">`,
);
p.push(`<rect x="0" y="0" width="540" height="502" fill="#ffffff" stroke="#e2e8f0"/>`);
p.push(
  `<text x="270" y="24" text-anchor="middle" font-size="15" font-weight="700" fill="${INK}">Reliability diagram: stated confidence vs actual accuracy</text>`,
);

// gridlines + ticks at 0, 0.25, 0.5, 0.75, 1.0
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  p.push(`<line x1="${px(t)}" y1="${Y1}" x2="${px(t)}" y2="${Y0}" stroke="#f1f5f9"/>`);
  p.push(`<line x1="${X0}" y1="${py(t)}" x2="${X1}" y2="${py(t)}" stroke="#f1f5f9"/>`);
  p.push(
    `<text x="${px(t)}" y="${Y0 + 18}" text-anchor="middle" font-size="11" fill="${INK}">${t.toFixed(2)}</text>`,
  );
  p.push(
    `<text x="${X0 - 10}" y="${py(t) + 4}" text-anchor="end" font-size="11" fill="${INK}">${t.toFixed(2)}</text>`,
  );
}

// perfect-calibration diagonal
p.push(
  `<line x1="${px(0)}" y1="${py(0)}" x2="${px(1)}" y2="${py(1)}" stroke="${GRAY}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
);
p.push(
  `<text x="${px(0.63)}" y="${py(0.63) - 7}" font-size="11" fill="${GRAY}" transform="rotate(-34 ${px(0.63)} ${py(0.63)})">perfect calibration</text>`,
);

// bars: blue = observed accuracy, red = gap up to the diagonal (overconfidence)
const W = 14;
bins.forEach((b, i) => {
  const cx = px(b.meanConfidence);
  const yAcc = py(b.accuracy);
  const yDiag = py(b.meanConfidence);
  p.push(
    `<rect x="${cx - W / 2}" y="${yDiag}" width="${W}" height="${+(yAcc - yDiag).toFixed(1)}" fill="${RED}" fill-opacity="0.28"/>`,
  );
  p.push(
    `<rect x="${cx - W / 2}" y="${yAcc}" width="${W}" height="${+(Y0 - yAcc).toFixed(1)}" fill="${BLUE}" fill-opacity="0.85"/>`,
  );
  p.push(`<circle cx="${cx}" cy="${yAcc}" r="3" fill="${BLUE}"/>`);
  // Stagger the count labels vertically so neighbouring bins never collide.
  p.push(
    `<text x="${cx}" y="${Y0 + 32 + (i % 2) * 13}" text-anchor="middle" font-size="9.5" fill="${INK}">n=${b.count}</text>`,
  );
});

// axis titles
p.push(
  `<text x="270" y="${Y0 + 64}" text-anchor="middle" font-size="12" fill="${INK}">model self-reported confidence</text>`,
);
p.push(
  `<text x="20" y="216" text-anchor="middle" font-size="12" fill="${INK}" transform="rotate(-90 20 216)">actual accuracy (fraction real)</text>`,
);

// headline annotation, upper-left where no data sits
p.push(
  `<text x="${X0 + 8}" y="${Y1 + 22}" font-size="12" fill="${INK}">mean confidence ${S.meanConfidence.toFixed(2)} vs actual accuracy ${S.accuracy.toFixed(3)}</text>`,
);
p.push(
  `<text x="${X0 + 8}" y="${Y1 + 40}" font-size="12" fill="${INK}">ECE ${S.ece.toFixed(2)}, Brier ${S.brier.toFixed(2)} (0 is perfect)</text>`,
);

// horizontal legend along the bottom, clear of the x-axis title
const ly = 488;
p.push(`<rect x="127" y="${ly - 9}" width="11" height="11" fill="${BLUE}" fill-opacity="0.85"/>`);
p.push(`<text x="143" y="${ly}" font-size="10.5" fill="${INK}">observed accuracy</text>`);
p.push(`<rect x="258" y="${ly - 9}" width="11" height="11" fill="${RED}" fill-opacity="0.28"/>`);
p.push(`<text x="274" y="${ly}" font-size="10.5" fill="${INK}">gap to perfect calibration</text>`);

p.push('</svg>');

const out = resolve(process.cwd(), 'docs/reliability.svg');
writeFileSync(out, `${p.join('\n')}\n`, 'utf8');
console.log(`-> ${out}  (${bins.length} bins, ECE ${S.ece}, Brier ${S.brier})`);
