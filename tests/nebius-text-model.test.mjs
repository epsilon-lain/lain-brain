import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import esbuild from 'esbuild';

const requests = [];
let responder = async () => ({ status: 200, json: {
  id: 'chat-test-1', model: 'nvidia/nemotron-3-super-120b-a12b',
  choices: [{ message: { content: 'A reply preserving personal meaning.' } }],
  usage: { prompt_tokens: 31, completion_tokens: 12 }
} });
const built = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/TextModelConfig';",
      "export * from './src/TextModelClient';",
      "export { migrateLainBrainSettings, getTextModelConfig } from './src/settings';",
      "export { askDeepSeek } from './src/DeepSeekClient';",
      "export { analyzeChatSemanticDelta } from './src/ChatSemanticDeltaAnalyzer';",
      "export { LainBrainSession } from './src/LainBrainSession';",
      "export { createVoiceIntentServices } from './src/VoiceIntentServices';",
      "export { generateMacroDefinitionCandidate } from './src/MacroDefinitionInterpreter';"
    ].join('\n'), resolveDir: process.cwd(), loader: 'ts'
  }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'obsidian-shim', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'shim' }));
    build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ loader: 'js', contents: `
      exports.requestUrl = (options) => globalThis.transport(options);
      exports.normalizePath = (path) => path;
      exports.MarkdownView = class MarkdownView {};
      exports.TFile = class TFile {};
      exports.parseLinktext = (path) => ({ path, subpath: '' });
      exports.resolveSubpath = () => null;
    ` }));
  } }]
});
const mod = { exports: {} };
let nextId = 0;
vm.runInNewContext(built.outputFiles[0].text, {
  module: mod, exports: mod.exports, require: createRequire(import.meta.url),
  console, URL, Blob, setTimeout, clearTimeout,
  DOMMatrix: class DOMMatrix {}, crypto: { randomUUID: () => `test-${++nextId}` },
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  transport: async (options) => {
    requests.push(options);
    return responder(options);
  }
});
const { migrateLainBrainSettings, getTextModelConfig, requestTextModel,
  NEBIUS_NEMOTRON_MODEL, NEBIUS_CHAT_URL, askDeepSeek,
  analyzeChatSemanticDelta, LainBrainSession, createVoiceIntentServices,
  generateMacroDefinitionCandidate } = mod.exports;
const key = 'secret-nebius-test-key';
const legacy = migrateLainBrainSettings({ deepSeekApiKey: 'legacy-key' });
assert.equal(legacy.textModelProvider, 'deepseek');
assert.equal(getTextModelConfig(legacy).apiKey, 'legacy-key');
assert.equal(migrateLainBrainSettings({ textModelProvider: 'invalid' }).textModelProvider, 'deepseek');
const settings = migrateLainBrainSettings({ textModelProvider: 'nebius',
  nebiusApiKey: ` ${key} `, deepSeekApiKey: 'other-provider-key' });
assert.equal(settings.nebiusModel, NEBIUS_NEMOTRON_MODEL);
assert.equal(getTextModelConfig(settings).apiKey, key);
const receipts = [];
const config = { ...getTextModelConfig(settings), onReceipt: (r) => receipts.push(r) };
await askDeepSeek(config, [{ role: 'user', content: 'Brain means my personal semantic system.' }]);
assert.equal(requests[0].url, NEBIUS_CHAT_URL);
assert.equal(requests[0].headers.Authorization, `Bearer ${key}`);
const body = JSON.parse(requests[0].body);
assert.equal(body.model, NEBIUS_NEMOTRON_MODEL);
assert.match(body.messages[0].content, /Do not silently replace/);
assert(!requests[0].body.includes(key));
assert.equal(receipts[0].requestedModel, NEBIUS_NEMOTRON_MODEL);
assert.equal(receipts[0].inputTokens, 31);
assert(!JSON.stringify(receipts).includes(key));
assert(Object.isFrozen(receipts[0]));

// Reject missing keys and a non-NVIDIA model before any network call.
const beforeBlocked = requests.length;
await assert.rejects(requestTextModel({ ...config, apiKey: '' }, []), /Nebius API key/);
await assert.rejects(requestTextModel({ ...config, model: 'deepseek-ai/DeepSeek-R1' }, []), /NVIDIA/);
assert.equal(requests.length, beforeBlocked);
assert.equal(getTextModelConfig({ ...settings, nebiusApiKey: '' }).apiKey, '');

// No fallback, no raw error bodies, no receipt for a failed HTTP request.
responder = async () => ({ status: 429, json: { error: { message: key } } });
const receiptsBeforeFailure = receipts.length;
await assert.rejects(requestTextModel(config, []), /Nebius request failed \(HTTP 429\)/);
assert.equal(requests.at(-1).url, NEBIUS_CHAT_URL);
assert.equal(receipts.length, receiptsBeforeFailure);
responder = async () => { throw new Error(`Provider echoed ${key}`); };
await assert.rejects(requestTextModel(config, []), (e) => !e.message.includes(key) && /Nebius/.test(e.message));
responder = async () => ({ status: 200, json: { id: key, model: key,
  choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: -1 } } });
await requestTextModel(config, []);
assert.equal(receipts.at(-1).requestId, undefined);
assert.equal(receipts.at(-1).servedModel, undefined);
assert.equal(receipts.at(-1).inputTokens, undefined);
for (const content of ['', null, 42]) {
  responder = async () => ({ status: 200, json: { choices: [{ message: { content } }] } });
  await assert.rejects(requestTextModel(config, []), /returned no answer/);
}

// Exact user evidence still comes through the conservative semantic parser.
const quote = 'When I say Brain, I mean my personal semantic system.';
responder = async () => ({ status: 200, json: { choices: [{ message: { content: JSON.stringify({
  outcome: 'possible_principal_change', changeKind: 'personal_definition',
  conceptQuery: 'Brain', proposedMeaning: 'My personal semantic system.',
  reason: 'Explicit definition.', confidence: 0.9, explicitness: 'explicit', tentative: false,
  evidence: [{ messageId: 'user-1', quote }]
}) } }] } });
const analysis = await analyzeChatSemanticDelta(config, {
  currentUserMessageId: 'user-1', conversation: [{ id: 'user-1', role: 'user', content: quote }]
});
assert.equal(analysis.kind, 'possible_principal_change');
assert.equal(analysis.evidence[0].snapshot, quote);
assert.equal(requests.at(-1).url, NEBIUS_CHAT_URL);

// A real Session path (mock network) produces a review proposal and no Vault writes.
const writes = [];
const app = {
  workspace: { getActiveFile: () => null, getActiveViewOfType: () => null },
  metadataCache: { resolvedLinks: {}, getFileCache: () => null, getFirstLinkpathDest: () => null },
  vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null,
    getFileByPath: () => null, getFolderByPath: () => null, cachedRead: async () => '',
    create: async (...args) => writes.push(args), modify: async (...args) => writes.push(args),
    createFolder: async (...args) => writes.push(args) }
};
let release;
let first = true;
let selected = config;
responder = async (options) => {
  const b = JSON.parse(options.body);
  const system = b.messages[0].content;
  if (system.includes('principal durable semantic change')) {
    const transcript = b.messages.at(-1).content;
    const id = transcript.match(/Current user message ID: (\S+)/)[1];
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify({
      outcome: 'possible_principal_change', changeKind: 'personal_definition',
      conceptQuery: 'Brain', proposedMeaning: 'My personal semantic system.',
      reason: 'Explicit definition.', confidence: 0.9, explicitness: 'explicit', tentative: false,
      evidence: [{ messageId: id, quote }]
    }) } }] } };
  }
  if (first) { first = false; await new Promise((resolve) => { release = resolve; }); }
  return { status: 200, json: { choices: [{ message: { content: 'I understand your personal definition.' } }] } };
};
const session = new LainBrainSession(app, () => selected);
session.setChatSemanticDeltaAnalysisEnabledProvider(() => true);
session.setChatSemanticAnalyzer(async () => { throw new Error('Isolated shadow analyzer'); });
session.setDraft(quote);
const firstRequestIndex = requests.length;
const pending = session.send();
while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
selected = { provider: 'deepseek', apiKey: 'legacy-key', model: 'deepseek-v4-flash' };
release();
assert.equal(await pending, 'sent');
await session.waitForChatSemanticDelta();
const proposal = session.getActiveChatSemanticDeltaProposal();
assert.equal(proposal.authority, 'proposed');
assert.equal(writes.length, 0);
assert(requests.slice(firstRequestIndex).every((r) => r.url === NEBIUS_CHAT_URL),
  'The in-flight turn and its background analysis keep the captured provider');
assert.equal(session.getChatTranscriptMessages().at(-1).providerId, 'nebius');
session.rejectActiveChatSemanticDelta();
assert.equal(writes.length, 0);
session.setDraft('Another conversation.');
await session.send();
await session.waitForChatSemanticDelta();
assert.equal(requests.at(-1).url, 'https://api.deepseek.com/chat/completions');
assert.equal(session.getChatTranscriptMessages().at(-1).providerId, 'deepseek');
selected = config;
const noKeySession = new LainBrainSession(app, () => ({ ...config, apiKey: '' }));
noKeySession.setDraft('hello');
const blockedIndex = requests.length;
assert.equal(await noKeySession.send(), 'blocked');
assert.equal(requests.length, blockedIndex);

// Voice text cleaning and macro generation also follow the selected provider.
responder = async () => ({ status: 200, json: { choices: [{ message: { content:
  '{"cleanedText":"my own vocabulary","possibleMacro":false,"candidateText":null}' } }] } });
const services = createVoiceIntentServices(() => config, () => '');
assert.equal((await services.clean('my own vocabulary', [])).cleanedText, 'my own vocabulary');
assert.equal(requests.at(-1).url, NEBIUS_CHAT_URL);
responder = async () => ({ status: 200, json: { choices: [{ message: { content: '{}' } }] } });
assert.equal((await generateMacroDefinitionCandidate(config, 'Define a recover macro.', [])).ok, false);
assert.equal(requests.at(-1).url, NEBIUS_CHAT_URL);
// Legacy bare-key callers remain DeepSeek callers.
responder = async () => ({ status: 200, json: { choices: [{ message: { content: 'legacy reply' } }] } });
await askDeepSeek('legacy-key', [{ role: 'user', content: 'hello' }]);
assert.equal(requests.at(-1).url, 'https://api.deepseek.com/chat/completions');
assert.equal(JSON.parse(requests.at(-1).body).model, 'deepseek-v4-flash');
console.log('PASS Nebius routing, migration, evidence review, provider snapshot, failure isolation and legacy compatibility (mock transport).');
