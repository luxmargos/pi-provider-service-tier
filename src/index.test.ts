import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SERVICE_TIERS,
  _test,
  buildPresetMapEntry,
  configPaths,
  ensureConfig,
  ensureMap,
  isServiceTier,
  isUnsupportedServiceTierError,
  mapSupportsTier,
  markTierUnsupported,
  mergeConfigs,
  modelKey,
  parseModelKey,
  presetTiersForModel,
  readConfig,
  readMap,
  resolveEffectiveConfig,
  resolveTierForModel,
  setScopedEntry,
  writeConfig,
  writeMap,
  type ConfigFile,
} from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-provider-service-tier-"));
}

const openAIModel = {
  provider: "openai",
  id: "gpt-5.5",
  api: "openai-responses",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

const codexModel = {
  provider: "openai-codex",
  id: "gpt-5.5",
  api: "openai-codex-responses",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

const opencodeQwenModel = {
  provider: "opencode-go",
  id: "qwen3.5-plus",
  api: "openai-completions",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

const opencodeMinimaxModel = {
  provider: "opencode-go",
  id: "minimax-m2.5",
  api: "anthropic-messages",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

test("recognizes known service tiers", () => {
  for (const tier of SERVICE_TIERS) assert.equal(isServiceTier(tier), true);
  assert.equal(isServiceTier("turbo"), false);
});

test("parses and formats provider/model keys", () => {
  assert.deepEqual(parseModelKey("openai/gpt-5.5"), { provider: "openai", id: "gpt-5.5" });
  assert.equal(parseModelKey("openai"), undefined);
  assert.equal(modelKey(openAIModel), "openai/gpt-5.5");
});

test("creates default config and map files", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    ensureConfig(paths.project);
    ensureConfig(paths.user);
    ensureMap(paths.map);
    assert.equal(existsSync(paths.project), true);
    assert.equal(existsSync(paths.user), true);
    assert.equal(existsSync(paths.map), true);
    assert.deepEqual(readConfig(paths.project)?.entries, {});
    assert.deepEqual(readMap(paths.map)?.entries, {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("ignores malformed JSON and invalid entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.user), { recursive: true });
    writeFileSync(paths.user, "{ bad json", "utf8");
    assert.equal(readConfig(paths.user), undefined);

    writeFileSync(
      paths.user,
      JSON.stringify({ aggressiveProbe: true, entries: { "bad": { active: true }, "openai/gpt-5.5": { active: true, serviceTier: "turbo" } } }),
      "utf8",
    );
    const config = readConfig(paths.user);
    assert.equal(config?.aggressiveProbe, true);
    assert.deepEqual(config?.entries, { "openai/gpt-5.5": { active: true } });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merges user and project config by provider/model key", () => {
  const paths = configPaths("/repo", "/home/user");
  const userConfig: ConfigFile = {
    aggressiveProbe: true,
    entries: {
      "openai/gpt-5.5": { active: true, serviceTier: "flex" },
      "openai/gpt-4.1": { active: true, serviceTier: "priority" },
    },
  };
  const projectConfig: ConfigFile = {
    entries: {
      "openai/gpt-5.5": { active: false },
    },
  };
  const effective = mergeConfigs(userConfig, projectConfig, paths);
  assert.equal(effective.aggressiveProbe, true);
  assert.deepEqual(effective.entries["openai/gpt-5.5"], { active: false, serviceTier: "flex" });
  assert.deepEqual(effective.entries["openai/gpt-4.1"], { active: true, serviceTier: "priority" });
});

test("project aggressiveProbe overrides user aggressiveProbe", () => {
  const paths = configPaths("/repo", "/home/user");
  assert.equal(mergeConfigs({ aggressiveProbe: true }, { aggressiveProbe: false }, paths).aggressiveProbe, false);
});

test("setScopedEntry writes provider/model entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    setScopedEntry(paths, "project", "openai/gpt-5.5", { active: true, serviceTier: "priority" });
    assert.deepEqual(readConfig(paths.project)?.entries?.["openai/gpt-5.5"], { active: true, serviceTier: "priority" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolves effective config from files", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    writeConfig(paths.user, { entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } });
    writeConfig(paths.project, { entries: { "openai/gpt-5.5": { serviceTier: "flex" } } });
    const effective = resolveEffectiveConfig(cwd, home);
    assert.deepEqual(effective.entries["openai/gpt-5.5"], { active: true, serviceTier: "flex" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("uses preset map support for known OpenAI APIs and bundled probe presets", () => {
  assert.deepEqual(presetTiersForModel(openAIModel), ["priority", "flex", "default", "auto", "scale"]);
  assert.deepEqual(presetTiersForModel(codexModel), ["priority", "default"]);
  assert.deepEqual(presetTiersForModel(opencodeQwenModel), ["priority", "flex", "default", "auto"]);
  assert.deepEqual(presetTiersForModel(opencodeMinimaxModel), []);
  assert.deepEqual(presetTiersForModel({ provider: "anthropic", api: "anthropic-messages" } as never), []);

  const entry = buildPresetMapEntry(codexModel);
  assert.equal(entry.supported, true);
  assert.equal(entry.source, "preset");
  assert.deepEqual(entry.tiers, ["priority", "default"]);
  assert.deepEqual(entry.unsupportedTiers, ["flex", "auto", "scale"]);

  const minimaxEntry = buildPresetMapEntry(opencodeMinimaxModel);
  assert.equal(minimaxEntry.supported, false);
  assert.deepEqual(minimaxEntry.tiers, []);
});

test("injects only when active and map-supported", () => {
  const paths = configPaths("/repo", "/home/user");
  const config = mergeConfigs(
    { entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } },
    undefined,
    paths,
  );
  const map = { entries: { "openai/gpt-5.5": buildPresetMapEntry(openAIModel) } };
  assert.equal(resolveTierForModel(config, map, openAIModel), "priority");
  assert.equal(mapSupportsTier(map, "openai/gpt-5.5", "priority"), true);

  const offConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: false, serviceTier: "priority" } } }, undefined, paths);
  assert.equal(resolveTierForModel(offConfig, map, openAIModel), undefined);

  const unsupportedConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "flex" } } }, undefined, paths);
  const priorityOnlyEntry = buildPresetMapEntry(openAIModel);
  priorityOnlyEntry.tiers = ["priority"];
  priorityOnlyEntry.supported = true;
  const codexMap = { entries: { "openai/gpt-5.5": priorityOnlyEntry } };
  assert.equal(resolveTierForModel(unsupportedConfig, codexMap, openAIModel), undefined);
});

test("payload helper adds top-level service_tier", () => {
  assert.deepEqual(_test.payloadWithServiceTier({ model: "x" }, "priority"), { model: "x", service_tier: "priority" });
  assert.equal(_test.payloadWithServiceTier(null, "priority"), undefined);
});

test("detects unsupported service_tier errors and updates map without retry state", () => {
  assert.equal(isUnsupportedServiceTierError("Unknown parameter: service_tier"), true);
  assert.equal(isUnsupportedServiceTierError("service_tier is not supported by this model"), true);
  assert.equal(isUnsupportedServiceTierError("rate limit"), false);

  const map = { entries: { "openai/gpt-5.5": buildPresetMapEntry(openAIModel) } };
  const next = markTierUnsupported(map, "openai/gpt-5.5", "priority", "service_tier unsupported");
  assert.equal(next.entries?.["openai/gpt-5.5"].tiers.includes("priority"), false);
  assert.equal(next.entries?.["openai/gpt-5.5"].unsupportedTiers?.includes("priority"), true);
});

test("aggressive mode is off by default", () => {
  const effective = mergeConfigs(undefined, undefined, configPaths("/repo", "/home/user"));
  assert.equal(effective.aggressiveProbe, false);
});

test("can persist map entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    writeMap(paths.map, { entries: { "openai/gpt-5.5": buildPresetMapEntry(openAIModel) } });
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"].supported, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("auto-seeds missing current-model map entry from presets", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    const seeded = _test.seedPresetMapEntryIfMissing(paths.map, { entries: {} }, codexModel);
    assert.deepEqual(seeded.entries?.["openai-codex/gpt-5.5"].tiers, ["priority", "default"]);
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"].supported, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
