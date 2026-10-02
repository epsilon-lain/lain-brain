// Independent Brain-side equivalence check of actual model proposals.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = process.argv[2];
if (!dir) throw new Error('Supply generated object-training output directory');
const temp = await mkdtemp(path.join(tmpdir(), 'lain-object-import-'));
try {
  const bundle = path.join(temp, 'TrainingLab.mjs');
  await build({ entryPoints: ['src/TrainingLab.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const lab = await import(pathToFileURL(bundle).href);
  const train = JSON.parse(await readFile(path.join(dir, 'train.tasks.json'), 'utf8'));
  const expected = new Map(train.map(r => [r.taskId, r.coefficients]));
  let state = lab.emptyTrainingLab(), correct = 0;
  const expr = x => {
    if (x.op === 'x') return [1, 0];
    if (x.op === 'const') return [0, Number(x.value)];
    if (x.op === 'scale') return expr(x.body).map(n => n * Number(x.factor));
    if (x.op === 'add') { const l = expr(x.left), r = expr(x.right); return l.map((n, i) => n + r[i]); }
    throw new Error('Unexpected expression');
  };
  for (let n = 1; n <= 2; n++) {
    const record = lab.parseTrainingRound(await readFile(path.join(dir, `round-${String(n).padStart(3, '0')}.json`), 'utf8'));
    assert.equal(record.config.mode, 'teacher_free');
    assert.equal(record.kind, 'training');
    assert.equal(record.candidates.length, 15);
    for (const c of record.candidates) {
      assert.equal(c.reference.split, 'train');
      assert.deepEqual(expr(c.reference.definition), expected.get(c.reference.taskId));
      assert(!c.teacher, 'No invented teacher report');
      if (JSON.stringify(expr(c.definition)) === JSON.stringify(expected.get(c.reference.taskId))) correct++;
    }
    state = lab.appendTrainingRound(state, record);
  }
  const checked = lab.inspectTrainingRun(state, state.rounds[0].runId);
  assert.equal(checked.objects.length, correct);
  assert.equal(checked.rounds.flatMap(r => r.verifications).filter(v => v.acceptance === 'rejected').length, 30 - correct);
  const exported = JSON.parse(lab.exportTrainingObjects(state, state.rounds[0].runId));
  assert.equal(exported.sourceKind, 'training');
  assert.equal(exported.objects.length, correct);
  assert(exported.objects.every(o => o.reference.split === 'train'));
  console.log(`PASS: Brain verified ${correct}/30 actual training proposals; rejected the remainder; training-only export`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
