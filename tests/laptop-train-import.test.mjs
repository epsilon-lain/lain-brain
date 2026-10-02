// Called by the Python smoke test with its actual generated round directory.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = process.argv[2];
if (!dir) throw new Error('Supply a generated training output directory');
const temp = await mkdtemp(path.join(tmpdir(), 'lain-training-import-'));
try {
  const bundle = path.join(temp, 'TrainingLab.mjs');
  await build({ entryPoints: ['src/TrainingLab.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const lab = await import(pathToFileURL(bundle).href);
  let state = lab.emptyTrainingLab();
  for (const name of ['round-001.json', 'round-002.json']) {
    state = lab.appendTrainingRound(state, lab.parseTrainingRound(await readFile(path.join(dir, name), 'utf8')));
  }
  assert.equal(state.rounds.length, 2);
  assert.deepEqual(state.rounds.map(r => r.measurements.steps), [2, 3]);
  const result = lab.inspectTrainingRun(state, state.rounds[0].runId);
  assert.equal(result.objects.length, 0);
  assert.equal(result.rounds.length, 2);
  assert(result.rounds.every(r => r.verifications.length === 0));
  console.log('PASS: Python-generated rounds accepted by the actual Brain Training Lab');
} finally {
  await rm(temp, { recursive: true, force: true });
}
