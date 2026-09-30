// Optional real-provider check. Run only after setting NEBIUS_API_KEY locally.
// No Vault data, API keys, raw provider errors or generated answers are printed.
import vm from 'node:vm';
import esbuild from 'esbuild';

const apiKey = process.env.NEBIUS_API_KEY?.trim();
if (!apiKey) {
  console.error('NOT RUN: set NEBIUS_API_KEY locally to run the real Nebius check.');
  process.exitCode = 2;
} else {
  const built = await esbuild.build({
    stdin: { contents: [
      "export { requestTextModel } from './src/TextModelClient';",
      "export { NEBIUS_NEMOTRON_MODEL } from './src/TextModelConfig';",
      "export { analyzeChatSemanticDelta } from './src/ChatSemanticDeltaAnalyzer';"
    ].join('\n'), resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'fetch-transport', setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
      build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ loader: 'js', contents: `
        exports.requestUrl = async (options) => {
          const response = await fetch(options.url, {
            method: options.method, headers: options.headers, body: options.body,
            signal: AbortSignal.timeout(90000)
          });
          const json = await response.json().catch(() => null);
          return { status: response.status, json };
        };
      ` }));
    } }]
  });
  const mod = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, {
    module: mod, exports: mod.exports, fetch, AbortSignal
  });
  const { requestTextModel, NEBIUS_NEMOTRON_MODEL, analyzeChatSemanticDelta } = mod.exports;
  const receipts = [];
  const config = { provider: 'nebius', apiKey,
    model: process.env.NEBIUS_MODEL?.trim() || NEBIUS_NEMOTRON_MODEL,
    onReceipt: (receipt) => receipts.push(receipt) };
  try {
    await requestTextModel(config, [{ role: 'user', content: 'Reply with OK.' }]);
    const content = 'When I say Brain, I mean my personal semantic system for communicating with AI and tools.';
    const analysis = await analyzeChatSemanticDelta(config, {
      currentUserMessageId: 'synthetic-user-1',
      conversation: [{ id: 'synthetic-user-1', role: 'user', content }]
    });
    console.log(JSON.stringify({ provider: 'nebius', mode: 'live',
      runtimeRequests: receipts, semanticAnalysisOutcome: analysis.kind,
      vaultWrites: 0, personalAuthorityGranted: false }, null, 2));
    if (analysis.kind !== 'possible_principal_change') {
      console.error('Runtime calls succeeded, but this synthetic definition did not yield a usable proposal.');
      process.exitCode = 1;
    }
  } catch {
    console.error('Nebius check failed. Check the API key, credits, model availability and network.');
    process.exitCode = 1;
  }
}
