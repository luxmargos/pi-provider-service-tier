import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SERVICE_TIERS,
  UNKNOWN_MODEL_BEHAVIORS,
  _test,
  buildPresetMapEntry,
  configPaths,
  ensureConfig,
  ensureMap,
  isServiceTier,
  isUnsupportedServiceTierError,
  isUnknownModelBehavior,
  mapSupportsTier,
  mapSupportState,
  markTierUnsupported,
  markTierSupported,
  mergeConfigs,
  modelKey,
  parseModelKey,
  presetTiersForModel,
  readConfig,
  readMap,
  resolveEffectiveConfig,
  resolveTierForModel,
  setScopedEntry,
  setScopedUnknownModelBehavior,
  writeConfig,
  writeMap,
  type ConfigFile,
} from "./index.ts";
import piServiceTier from "./index.ts";

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

function createExtensionHarness(cwd: string, home: string, model: never = openAIModel, available: never[] = [openAIModel]) {
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> | void }>();
  const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown> | unknown>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const selections: string[] = [];
  const ctx = {
    cwd,
    model,
    modelRegistry: {
      getAvailable: () => available,
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      addAutocompleteProvider: () => undefined,
      select: async () => selections.shift(),
    },
  } as never;
  const pi = {
    registerCommand: (name: string, options: { handler: (args: string, ctx: never) => Promise<void> | void }) => {
      commands.set(name, options);
    },
    on: (name: string, handler: (event: never, ctx: never) => Promise<unknown> | unknown) => {
      handlers.set(name, handler);
    },
  } as never;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  piServiceTier(pi);
  return {
    commands,
    handlers,
    ctx,
    notifications,
    statuses,
    selections,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

test("recognizes known service tiers", () => {
  for (const tier of SERVICE_TIERS) assert.equal(isServiceTier(tier), true);
  assert.equal(isServiceTier("turbo"), false);
  for (const behavior of UNKNOWN_MODEL_BEHAVIORS) assert.equal(isUnknownModelBehavior(behavior), true);
  assert.equal(isUnknownModelBehavior("prompt"), false);
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
    assert.equal(readConfig(paths.project)?.version, 2);
    assert.equal(readMap(paths.map)?.version, 2);
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
      JSON.stringify({
        aggressiveProbe: true,
        unknownModelBehavior: "turbo",
        entries: { "bad": { active: true }, "openai/gpt-5.5": { active: true, serviceTier: "turbo" } },
      }),
      "utf8",
    );
    const config = readConfig(paths.user);
    assert.equal(config?.unknownModelBehavior, undefined);
    assert.deepEqual(config?.entries, { "openai/gpt-5.5": { active: true } });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merges user and project config by provider/model key", () => {
  const paths = configPaths("/repo", "/home/user");
  const userConfig: ConfigFile = {
    unknownModelBehavior: "aggressive",
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
  assert.equal(effective.unknownModelBehavior, "aggressive");
  assert.deepEqual(effective.entries["openai/gpt-5.5"], { active: false, serviceTier: "flex" });
  assert.deepEqual(effective.entries["openai/gpt-4.1"], { active: true, serviceTier: "priority" });
});

test("project unknown behavior overrides user unknown behavior", () => {
  const paths = configPaths("/repo", "/home/user");
  assert.equal(
    mergeConfigs({ unknownModelBehavior: "aggressive" }, { unknownModelBehavior: "unknown" }, paths)
      .unknownModelBehavior,
    "unknown",
  );
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

test("setScopedUnknownModelBehavior writes unknown behavior without dropping entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    setScopedEntry(paths, "project", "openai/gpt-5.5", { active: true, serviceTier: "priority" });
    setScopedUnknownModelBehavior(paths, "project", "aggressive");
    const config = readConfig(paths.project);
    assert.equal(config?.unknownModelBehavior, "aggressive");
    assert.deepEqual(config?.entries?.["openai/gpt-5.5"], { active: true, serviceTier: "priority" });
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

test("migrates config writes to v2 and drops legacy aggressiveProbe", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.user), { recursive: true });
    writeFileSync(
      paths.user,
      JSON.stringify({ version: 1, aggressiveProbe: true, entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } }),
      "utf8",
    );
    const config = readConfig(paths.user);
    assert.equal(config?.version, 2);
    assert.equal(config?.unknownModelBehavior, undefined);
    writeConfig(paths.user, config ?? {});
    const written = readConfig(paths.user);
    assert.equal(written?.version, 2);
    assert.equal(written?.unknownModelBehavior, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrates v1 map by removing fully unsupported entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.map), { recursive: true });
    writeFileSync(
      paths.map,
      JSON.stringify({
        version: 1,
        entries: {
          "openai/gpt-5.5": buildPresetMapEntry(openAIModel),
          "openai/gpt-old": {
            provider: "openai",
            id: "gpt-old",
            supported: false,
            tiers: [],
            source: "error",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const map = readMap(paths.map);
    assert.equal(map?.version, 2);
    assert.equal(Boolean(map?.entries?.["openai/gpt-5.5"]), true);
    assert.equal(map?.entries?.["openai/gpt-old"], undefined);
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

test("status text omits provider/model key", () => {
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const paths = configPaths("/repo", "/home/user");
    const config = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } }, undefined, paths);
    const map = { entries: { "openai/gpt-5.5": buildPresetMapEntry(openAIModel) } };
    assert.equal(_test.statusText(config, map, openAIModel), "⚡ priority");
    assert.equal(_test.statusText(config, { entries: {} }, openAIModel), "⚡ priority unknown");
    const flexConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "flex" } } }, undefined, paths);
    assert.equal(_test.statusText(flexConfig, map, openAIModel), "● flex");
    const offConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: false, serviceTier: "priority" } } }, undefined, paths);
    assert.equal(_test.statusText(offConfig, map, openAIModel), "○ off");
    const unsetConfig = mergeConfigs(undefined, undefined, paths);
    assert.equal(_test.statusText(unsetConfig, map, openAIModel), "○ off");
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test("status text does not yellow-highlight off or unknown states", () => {
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const paths = configPaths("/repo", "/home/user");
    const offConfig = mergeConfigs(undefined, undefined, paths);
    assert.equal(_test.statusText(offConfig, { entries: {} }, openAIModel), "○ off");
    const unknownConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } }, undefined, paths);
    assert.equal(_test.statusText(unknownConfig, { entries: {} }, openAIModel), "⚡ priority unknown");
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
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
  assert.equal(mapSupportState(next, "openai/gpt-5.5", "priority"), "unknown");
  assert.equal(mapSupportState({ entries: {} }, "openai/gpt-5.5", "priority"), "unknown");
});

test("marks aggressive-once success as supported", () => {
  const map = { entries: { "openai/gpt-5.5": markTierUnsupported({ entries: {} }, "openai/gpt-5.5", "priority").entries?.["openai/gpt-5.5"]! } };
  const next = markTierSupported(map, "openai/gpt-5.5", "priority", openAIModel);
  assert.equal(next.entries?.["openai/gpt-5.5"].supported, true);
  assert.deepEqual(next.entries?.["openai/gpt-5.5"].tiers, ["priority"]);
  assert.equal(next.entries?.["openai/gpt-5.5"].unsupportedTiers?.includes("priority") ?? false, false);
});

test("unknown behavior defaults to ask", () => {
  const effective = mergeConfigs(undefined, undefined, configPaths("/repo", "/home/user"));
  assert.equal(effective.unknownModelBehavior, "ask");
});

test("unknown behavior command exports completions", () => {
  assert.equal(_test.COMMAND_UNKNOWN_BEHAVIOR, "service-tier-unknown-behavior");
  assert.deepEqual(_test.unknownBehaviorCompletions("a"), [
    { value: "ask", label: "ask" },
    { value: "aggressive", label: "aggressive" },
  ]);
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

test("registers new commands and omits removed commands", () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    assert.equal(harness.commands.has("service-tier-fast-project"), true);
    assert.equal(harness.commands.has("service-tier-fast-user"), true);
    assert.equal(harness.commands.has("fast-project"), true);
    assert.equal(harness.commands.has("fast-user"), true);
    assert.equal(harness.commands.has("service-tier-refresh-support"), true);
    assert.equal(harness.commands.has("service-tier-refresh-support-all"), true);
    assert.equal(harness.commands.has("service-tier-unset-support"), true);
    assert.equal(harness.commands.has("service-tier-unset-support-all"), true);
    assert.equal(harness.commands.has("service-tier-unknown-behavior"), true);
    assert.equal(harness.commands.has("service-tier-build-map"), false);
    assert.equal(harness.commands.has("service-tier-build-map-all"), false);
    assert.equal(harness.commands.has("service-tier-aggressive-probe"), false);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("session start does not seed presets passively", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const paths = configPaths(cwd, home);
    assert.deepEqual(readMap(paths.map)?.entries, {});
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("fast command seeds preset support explicitly", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    await harness.commands.get("service-tier-fast-user")?.handler("on", harness.ctx);
    const paths = configPaths(cwd, home);
    assert.deepEqual(readConfig(paths.user)?.entries?.["openai-codex/gpt-5.5"], { active: true, serviceTier: "priority" });
    assert.deepEqual(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"].tiers, ["priority", "default"]);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("tier changes always refresh preset support before evaluating unknown support", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    const staleEntry = buildPresetMapEntry(codexModel);
    staleEntry.tiers = ["priority", "flex", "default"];
    staleEntry.supported = true;
    writeMap(paths.map, { entries: { "openai-codex/gpt-5.5": staleEntry } });
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.deepEqual(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"].tiers, ["priority", "default"]);
    assert.equal(
      harness.notifications.some(({ message }) => message.includes("will remain disabled")),
      true,
    );
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("refresh and unset support commands write preset then make support unknown", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    await harness.commands.get("service-tier-refresh-support")?.handler("", harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"].supported, true);
    await harness.commands.get("service-tier-unset-support")?.handler("", harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"], undefined);
    await harness.commands.get("service-tier-refresh-support-all")?.handler("", harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"].supported, true);
    await harness.commands.get("service-tier-unset-support-all")?.handler("", harness.ctx);
    assert.deepEqual(readMap(paths.map)?.entries, {});
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown behavior command persists to user config", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    await harness.commands.get("service-tier-unknown-behavior")?.handler("aggressive", harness.ctx);
    assert.equal(readConfig(paths.user)?.unknownModelBehavior, "aggressive");
    assert.equal(readConfig(paths.project), undefined);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("ask flow authorizes aggressive-once injection and persists success", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Use aggressive mode once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "flex" });
    await harness.handlers.get("message_end")?.({ message: { role: "assistant" } } as never, harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"].tiers.includes("flex"), true);
    assert.equal(
      harness.notifications.some(({ message }) => message.includes("aggressive injection started")),
      true,
    );
    const secondPayload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(secondPayload, { model: "gpt-5.5", service_tier: "flex" });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("ask flow aggressive always works on the next request and reports progress", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Use aggressive mode and do not ask again");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.equal(readConfig(paths.user)?.unknownModelBehavior, "aggressive");
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "flex" });
    assert.equal(
      harness.notifications.some(({ message }) => message.includes("waiting for provider result")),
      true,
    );
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unsupported errors update map without retry", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    writeConfig(paths.user, { unknownModelBehavior: "aggressive", entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } });
    writeMap(paths.map, { entries: {} });
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "priority" });
    await harness.handlers.get("message_end")?.(
      { message: { role: "assistant", errorMessage: "service_tier is not supported by this model" } } as never,
      harness.ctx,
    );
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"].unsupportedTiers?.includes("priority"), true);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
