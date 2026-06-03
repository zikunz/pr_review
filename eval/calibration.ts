/**
 * Confidence calibration (Experiment 10).
 *
 * Every finding carries a model self-reported confidence (0 to 1). Experiment 8
 * produced a hand label for each of the 83 findings (true positive or not). This
 * script measures how well the self-reported confidence tracks the ground truth,
 * the standard way a probabilistic classifier is evaluated:
 *
 *   - a reliability table: bin findings by confidence, and for each bin compare
 *     the mean confidence (what the model claimed) to the fraction that are
 *     actually true positives (what was real);
 *   - Expected Calibration Error (ECE): the bin-weighted average gap between the
 *     two, where 0 is perfect calibration;
 *   - the Brier score: mean squared error of confidence against the 0/1 outcome,
 *     where 0 is perfect and a model that always guessed the base rate would
 *     score about the base rate.
 *
 * It reads eval/eval-gate-full-audit.jsonl, which carries each finding's
 * confidence and its Experiment 8 ground-truth label. No model calls, no key.
 *
 * Run: npx tsx eval/calibration.ts
 * Output: eval/eval-calibration.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Row {
  confidence: number;
  truth: 'true_positive' | 'borderline' | 'false_positive';
}

const IN = resolve(process.cwd(), 'eval/eval-gate-full-audit.jsonl');
const OUT = resolve(process.cwd(), 'eval/eval-calibration.json');
const BINS: Array<[number, number]> = [
  [0, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 0.95],
  [0.95, 1.0001],
];

// A finding "counts as correct" when it is a genuine, worth-posting issue. The
// strict outcome credits only the one clear true positive; the lenient outcome
// also credits the two borderline findings. The picture is the same either way.
function calibrate(rows: Row[], lenient: boolean) {
  const pts = rows.map((r) => ({
    c: r.confidence,
    y: r.truth === 'true_positive' || (lenient && r.truth === 'borderline') ? 1 : 0,
  }));
  const n = pts.length;
  const meanConf = pts.reduce((a, p) => a + p.c, 0) / n;
  const accuracy = pts.reduce((a, p) => a + p.y, 0) / n;
  const brier = pts.reduce((a, p) => a + (p.c - p.y) ** 2, 0) / n;
  let ece = 0;
  const table = [];
  for (const [lo, hi] of BINS) {
    const b = pts.filter((p) => p.c >= lo && p.c < hi);
    if (b.length === 0) {
      table.push({ bin: `[${lo}, ${hi})`, count: 0, meanConfidence: null, accuracy: null });
      continue;
    }
    const mc = b.reduce((a, p) => a + p.c, 0) / b.length;
    const acc = b.reduce((a, p) => a + p.y, 0) / b.length;
    ece += (b.length / n) * Math.abs(mc - acc);
    table.push({
      bin: `[${lo}, ${hi})`,
      count: b.length,
      meanConfidence: Number(mc.toFixed(3)),
      accuracy: Number(acc.toFixed(3)),
      truePositives: b.filter((p) => p.y).length,
    });
  }
  return {
    findings: n,
    meanConfidence: Number(meanConf.toFixed(3)),
    accuracy: Number(accuracy.toFixed(3)),
    overconfidenceGap: Number((meanConf - accuracy).toFixed(3)),
    ece: Number(ece.toFixed(3)),
    brier: Number(brier.toFixed(3)),
    reliability: table,
  };
}

function main(): void {
  const rows: Row[] = readFileSync(IN, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const strict = calibrate(rows, false);
  const lenient = calibrate(rows, true);

  console.log(`Confidence calibration over ${strict.findings} findings\n`);
  console.log('bin            n   mean_conf   accuracy');
  for (const r of strict.reliability) {
    if (r.count === 0) {
      console.log(`${r.bin.padEnd(13)}  0   -`);
      continue;
    }
    console.log(
      `${r.bin.padEnd(13)} ${String(r.count).padStart(2)}    ${r.meanConfidence?.toFixed(3)}      ${r.accuracy?.toFixed(3)}  (${r.truePositives}/${r.count} real)`,
    );
  }
  console.log(
    `\nmean confidence ${strict.meanConfidence}, actual accuracy ${strict.accuracy}, overconfidence gap ${strict.overconfidenceGap}`,
  );
  console.log(`ECE ${strict.ece}   Brier ${strict.brier}   (0 is perfect)`);
  console.log(
    `\nlenient (borderline counted as real): accuracy ${lenient.accuracy}, ECE ${lenient.ece}, Brier ${lenient.brier}`,
  );

  writeFileSync(OUT, `${JSON.stringify({ strict, lenient }, null, 2)}\n`, 'utf8');
  console.log(`\n-> ${OUT}`);
}

main();
