import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: [
      "export {",
      "  buildExperiment04ProviderMessages,",
      "  assertExperiment04PromptHasNoInternalConditionIds",
      "} from './src/Experiment04Instrument';"
    ].join("\n"),
    resolveDir: process.cwd(),
    sourcefile: "experiment04-instrument-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false
});

const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  console
});

const {
  buildExperiment04ProviderMessages,
  assertExperiment04PromptHasNoInternalConditionIds
} = module.exports;

const fixture = {
  id: "fixture-personal-meaning",
  sourceText: "The term lantern means the user's enduring project.",
  treatmentPayloads: {
    irrelevant: "A basalt column forms when lava cools slowly.",
    identityOnly: "Stable concept ID: concept-lantern@2. Aliases: lantern, enduring project.",
    definition: "Definition: Lantern is the user's enduring project, not a physical lamp.",
    relations: "Relations: Lantern supports Project A; Project A is revised by Note B."
  }
};

const expectedContext = {
  plain_llm: undefined,
  irrelevant_context: fixture.treatmentPayloads.irrelevant,
  brain_identity_only: fixture.treatmentPayloads.identityOnly,
  brain_definition: [fixture.treatmentPayloads.identityOnly, fixture.treatmentPayloads.definition].join("\n"),
  brain_definition_plus_relations: [
    fixture.treatmentPayloads.identityOnly,
    fixture.treatmentPayloads.definition,
    fixture.treatmentPayloads.relations
  ].join("\n")
};

const fakeProvider = {
  calls: [],
  async complete(messages) {
    this.calls.push(messages);
    return '{"conceptBindings":[]}';
  }
};

for (const [condition, context] of Object.entries(expectedContext)) {
  const messages = buildExperiment04ProviderMessages(fixture, condition);
  await fakeProvider.complete(messages);
  const visible = messages.map((message) => message.content).join("\n");
  assert.match(visible, /The term lantern means/);
  if (context === undefined) {
    assert.equal(visible.includes("Reference context:"), false);
  } else {
    assert.equal(visible.includes(context), true);
  }
  for (const internalId of [
    "plain_llm",
    "irrelevant_context",
    "brain_identity_only",
    "brain_definition",
    "brain_definition_plus_relations"
  ]) {
    assert.equal(visible.includes(internalId), false, `${condition} leaked ${internalId}`);
  }
}
assert.equal(fakeProvider.calls.length, 5);

assert.throws(
  () => assertExperiment04PromptHasNoInternalConditionIds([
    { role: "user", content: "Condition: brain_definition" }
  ]),
  /internal condition identifier/
);

console.log("experiment04-instrument.test.mjs PASS");
