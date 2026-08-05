import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const built = await esbuild.build({
  stdin: {
    contents: `
      export {
        createImageDataUrl,
        MAX_VISION_IMAGE_BYTES,
        VisionProviderRouter
      } from "./src/OpenAIVisionClient";
      export {
        createCustomProviderProfile,
        OPENAI_RESPONSES_URL,
        OPENAI_VISION_PROFILE_ID,
        QWEN_COMPATIBLE_BASE_URL,
        QWEN_VISION_PROFILE_ID
      } from "./src/ProviderProfiles";
      export {
        migrateLainBrainSettings,
        removeCustomProviderProfile
      } from "./src/settings";
      export { LainBrainSession } from "./src/LainBrainSession";
    `,
    resolveDir: process.cwd(),
    sourcefile: "vision-providers-entry.ts",
    loader: "ts"
  },
  absWorkingDir: process.cwd(),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2021",
  write: false,
  plugins: [{
    name: "obsidian-shim",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: "obsidian",
        namespace: "shim"
      }));
      build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
        loader: "js",
        contents: `
          exports.normalizePath = (value) => value.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");
          exports.requestUrl = async () => { throw new Error("Unexpected DeepSeek request"); };
        `
      }));
    }
  }]
});
const module = { exports: {} };
const capturedLogs = [];
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require,
  URL,
  crypto: { randomUUID: () => "test-profile-id" },
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  console: {
    log: (...values) => capturedLogs.push(values.join(" ")),
    warn: (...values) => capturedLogs.push(values.join(" ")),
    error: (...values) => capturedLogs.push(values.join(" "))
  },
  setTimeout,
  clearTimeout
});
const {
  createCustomProviderProfile,
  createImageDataUrl,
  LainBrainSession,
  MAX_VISION_IMAGE_BYTES,
  migrateLainBrainSettings,
  OPENAI_RESPONSES_URL,
  OPENAI_VISION_PROFILE_ID,
  QWEN_COMPATIBLE_BASE_URL,
  QWEN_VISION_PROFILE_ID,
  removeCustomProviderProfile,
  VisionProviderRouter
} = module.exports;

function makeImage({
  name = "diagram.png",
  type = "image/png",
  bytes = [0, 1, 2, 3, 255],
  size = bytes.length,
  onRead = () => {}
} = {}) {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => {
      onRead();
      return Uint8Array.from(bytes).buffer;
    }
  };
}

function imageCapabilities(supportsImages = true) {
  return {
    supportsText: true,
    supportsImages,
    supportsPdf: false
  };
}

function profile(overrides = {}) {
  return {
    id: "provider-a",
    displayName: "Provider A",
    protocol: "openai-responses",
    baseUrl: OPENAI_RESPONSES_URL,
    model: "vision-model",
    apiKey: "provider-a-secret",
    capabilities: imageCapabilities(),
    ...overrides
  };
}

function okJson(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  };
}

const image = makeImage();
const expectedDataUrl = "data:image/png;base64,AAECA/8=";
assert.equal(await createImageDataUrl(image), expectedDataUrl);

const openAIRequests = [];
const openAIRouter = new VisionProviderRouter(async (url, init) => {
  openAIRequests.push({ url, init });
  return okJson({ output_text: "OpenAI answer" });
});
const openAIProfile = profile({
  id: OPENAI_VISION_PROFILE_ID,
  displayName: "OpenAI Vision",
  builtInKind: "openai"
});
const openAIResult = await openAIRouter.analyzeImage(
  openAIProfile,
  "Explain this image.",
  image
);
assert.equal(openAIResult.text, "OpenAI answer");
assert.equal(openAIRequests[0].url, OPENAI_RESPONSES_URL);
const openAIBody = JSON.parse(openAIRequests[0].init.body);
assert.deepEqual(openAIBody.input, [{
  role: "user",
  content: [
    { type: "input_text", text: "Explain this image." },
    { type: "input_image", image_url: expectedDataUrl, detail: "auto" }
  ]
}]);

const compatibleRequests = [];
const compatibleRouter = new VisionProviderRouter(async (url, init) => {
  compatibleRequests.push({ url, init });
  return okJson({ choices: [{ message: { content: "Compatible answer" } }] });
});
const qwenProfile = profile({
  id: QWEN_VISION_PROFILE_ID,
  displayName: "Qwen Vision",
  protocol: "openai-chat-completions",
  baseUrl: QWEN_COMPATIBLE_BASE_URL,
  model: "qwen-vl-model",
  apiKey: "qwen-secret",
  builtInKind: "qwen"
});
await compatibleRouter.analyzeImage(qwenProfile, "Read diagram", image);
assert.equal(
  compatibleRequests[0].url,
  `${QWEN_COMPATIBLE_BASE_URL}/chat/completions`
);
const qwenBody = JSON.parse(compatibleRequests[0].init.body);
assert.deepEqual(qwenBody.messages, [{
  role: "user",
  content: [
    { type: "text", text: "Read diagram" },
    { type: "image_url", image_url: { url: expectedDataUrl } }
  ]
}]);

const customProfile = profile({
  id: "custom-provider",
  displayName: "My Vision API",
  protocol: "openai-chat-completions",
  baseUrl: "https://vision.example.test/api/v1/",
  model: "custom-vision-model",
  apiKey: "custom-secret"
});
await compatibleRouter.analyzeImage(customProfile, "Custom prompt", image);
assert.equal(
  compatibleRequests[1].url,
  "https://vision.example.test/api/v1/chat/completions"
);
assert.equal(
  JSON.parse(compatibleRequests[1].init.body).model,
  "custom-vision-model"
);

let rejectedNetworkCalls = 0;
const neverRouter = new VisionProviderRouter(async () => {
  rejectedNetworkCalls += 1;
  throw new Error("Network must not be called");
});
await assert.rejects(
  neverRouter.analyzeImage(
    qwenProfile,
    "Question",
    makeImage({ type: "image/svg+xml" })
  ),
  /PNG, JPEG, WebP, or GIF/
);
await assert.rejects(
  neverRouter.analyzeImage(
    qwenProfile,
    "Question",
    makeImage({ size: MAX_VISION_IMAGE_BYTES + 1 })
  ),
  /10 MiB/
);
assert.equal(rejectedNetworkCalls, 0);

const errorSecret = "never-print-this-key";
const unsafeData = "data:image/png;base64,QUJDREVGRw==";
const errorRouter = new VisionProviderRouter(async () => ({
  ok: false,
  status: 400,
  text: async () => `${errorSecret} ${unsafeData} ${"x".repeat(500)}`
}));
let safeError = "";
try {
  await errorRouter.analyzeImage(
    profile({ apiKey: errorSecret }),
    "Question",
    image
  );
} catch (error) {
  safeError = error.message;
}
assert.equal(safeError.includes(errorSecret), false);
assert.equal(safeError.includes(unsafeData), false);
assert.equal(capturedLogs.some((line) => line.includes(errorSecret)), false);

const migrated = migrateLainBrainSettings({
  deepSeekApiKey: "deep-key",
  openAIVisionEnabled: true,
  openAIVisionApiKey: "legacy-openai-key",
  openAIVisionModel: "legacy-model"
});
const migratedOpenAI = migrated.imageProviderProfiles.find(
  (item) => item.id === OPENAI_VISION_PROFILE_ID
);
assert.equal(migratedOpenAI.apiKey, "legacy-openai-key");
assert.equal(migratedOpenAI.model, "legacy-model");
assert.equal(migrated.activeImageProviderId, OPENAI_VISION_PROFILE_ID);

const custom = createCustomProviderProfile();
const removalSettings = migrateLainBrainSettings(undefined);
removalSettings.imageProviderProfiles.push(custom);
removalSettings.activeImageProviderId = custom.id;
assert.equal(removeCustomProviderProfile(removalSettings, custom.id), true);
assert.equal(removalSettings.activeImageProviderId, null);
assert.equal(
  removalSettings.imageProviderProfiles.some((item) => item.id === custom.id),
  false
);

function makeApp() {
  return {
    vault: {
      cachedRead: async () => "",
      getMarkdownFiles: () => [],
      getFileByPath: () => null,
      getAbstractFileByPath: () => null
    },
    metadataCache: { getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) }
  };
}

let activeProfile = openAIProfile;
let visionCalls = 0;
let deepSeekCalls = 0;
const sessionVisionClient = {
  analyzeImage: async (selectedProfile, _prompt, _image) => {
    visionCalls += 1;
    return {
      text: "Vision answer",
      providerId: selectedProfile.id,
      providerDisplayName: selectedProfile.displayName
    };
  }
};
const session = new LainBrainSession(
  makeApp(),
  () => "deepseek-key",
  () => activeProfile,
  sessionVisionClient,
  async () => {
    deepSeekCalls += 1;
    return "DeepSeek answer";
  }
);
session.setDraft("Explain image");
session.setPendingVisionImage(image);
assert.equal(await session.send(), "needs-vision-confirmation");
assert.equal(visionCalls, 0);
assert.equal(await session.send(openAIProfile.id), "sent");
assert.equal(visionCalls, 1);
assert.equal(deepSeekCalls, 0);

session.setDraft("Second OpenAI image");
session.setPendingVisionImage(image);
assert.equal(await session.send(), "sent");
assert.equal(visionCalls, 2);

activeProfile = qwenProfile;
session.setDraft("First Qwen image");
session.setPendingVisionImage(image);
assert.equal(await session.send(), "needs-vision-confirmation");
assert.equal(visionCalls, 2);
assert.equal(await session.send(qwenProfile.id), "sent");
assert.equal(visionCalls, 3);
const sourceMessages = session.getCandidateSourceMessages();
assert.equal(
  sourceMessages.some((message) =>
    message.content.includes(
      "Source attachment: diagram.png (analyzed with Qwen Vision)"
    )
  ),
  true
);
assert.equal(
  sourceMessages.some((message) => /base64|data:image/i.test(message.content)),
  false
);

session.setPendingVisionImage(makeImage({
  name: "remove.jpg",
  type: "image/jpeg"
}));
session.removePendingVisionImage();
assert.equal(session.getPendingVisionImage(), undefined);

let textVisionCalls = 0;
let textDeepSeekCalls = 0;
const textSession = new LainBrainSession(
  makeApp(),
  () => "deepseek-key",
  () => openAIProfile,
  {
    analyzeImage: async () => {
      textVisionCalls += 1;
      throw new Error("Vision must not be called");
    }
  },
  async () => {
    textDeepSeekCalls += 1;
    return "Text answer";
  }
);
textSession.setDraft("Text-only question");
assert.equal(await textSession.send(), "sent");
assert.equal(textDeepSeekCalls, 1);
assert.equal(textVisionCalls, 0);

const exactConfigurationError =
  "The selected AI provider cannot analyze images. Choose a Vision-capable provider in Lain Brain settings.";
for (const invalidProfile of [
  null,
  profile({ apiKey: "" }),
  profile({ baseUrl: "http://insecure.example.test" }),
  profile({ capabilities: imageCapabilities(false) })
]) {
  let invalidNetworkCalls = 0;
  let imageReadCalls = 0;
  const invalidSession = new LainBrainSession(
    makeApp(),
    () => "deepseek-key",
    () => invalidProfile,
    {
      analyzeImage: async () => {
        invalidNetworkCalls += 1;
        throw new Error("Network must not be called");
      }
    }
  );
  invalidSession.setDraft("Analyze");
  invalidSession.setPendingVisionImage(makeImage({
    onRead: () => { imageReadCalls += 1; }
  }));
  assert.equal(await invalidSession.send(), "blocked");
  assert.equal(invalidNetworkCalls, 0);
  assert.equal(imageReadCalls, 0);
  assert.equal(
    invalidSession.getTranscriptMessages().at(-1).content,
    exactConfigurationError
  );
  assert.notEqual(invalidSession.getPendingVisionImage(), undefined);
}

const sensitiveOutputs = [
  safeError,
  ...sourceMessages.map((message) => message.content)
].join("\n");
for (const key of [
  errorSecret,
  openAIProfile.apiKey,
  qwenProfile.apiKey,
  customProfile.apiKey
]) {
  assert.equal(sensitiveOutputs.includes(key), false);
}
assert.equal(/data:image|base64/i.test(sensitiveOutputs), false);

console.log(JSON.stringify({
  deepSeekTextOnlyCalls: textDeepSeekCalls,
  openAIResponsesRequest: "PASS",
  qwenChatCompletionsRequest: "PASS",
  customProviderEndpointAndModel: "PASS",
  invalidProviderNetworkCalls: 0,
  providerConfirmations: [openAIProfile.id, qwenProfile.id],
  invalidImageNetworkCalls: rejectedNetworkCalls,
  transientImageCleared: true,
  legacyOpenAIMigrated: true,
  activeCustomDeletionResetsDisabled: true,
  secretsOrBase64InOutput: false,
  result: "PASS"
}, null, 2));