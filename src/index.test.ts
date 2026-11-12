import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SERVICE_TIERS,
  UNKNOWN_MODEL_BEHAVIORS,
  _test,
  ConfigFileError,
  configPaths,
  ensureConfig,
  ensureMap,
  isServiceTier,
  isServiceTierModelSupported,
  isServiceTierProviderSupported,
  configuredTierForModel,
  isUnsupportedServiceTierError,
  isUnknownModelBehavior,
  mapSupportsTier,
  mapSupportState,
  markTierProbeResults,
  markTierUnsupported,
  markTierSupported,
  mergeConfigs,
  modelKey,
  parseModelKey,
  readConfig,
  readMap,
  resolveEffectiveConfig,
  resolveTierForModel,
  setScopedEntry,
  setScopedUnknownModelBehavior,
  setScopedStatusFormat,
  writeConfig,
  writeMap,
  type ConfigFile,
  type ServiceTier,
  type ServiceTierMapFile,
  type ServiceTierMapEntry,
} from "./index.ts";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import piServiceTier from "./index.ts";
import { putRoute } from "./support-map.ts";
import { type AuthMode } from "./auth-scope.ts";
import { probeCandidates, type ProbeTierObservation, type ProbeTierResult } from "./probe-evidence.ts";
import { TIER_PICKER_LEGEND, tierChoices } from "./tier-picker.ts";
import { STATUS_FORMAT_PRESETS } from "./status-format.ts";

function fixtureResults(results: Partial<Record<import("./index.ts").ServiceTier, ProbeTierResult>>, model = openAIModel) {
  return Object.fromEntries(Object.entries(results).filter(([tier]) => probeCandidates(model).includes(tier as never)).map(([tier, result]) => [tier, {
    result, kind: result === "supported" ? "verified" : result === "unsupported" ? "rejected" : "legacy",
    payloadPrepared: result !== "unknown", requestCompleted: result === "supported",
    ...(result === "supported" ? { servedTier: tier === "auto" ? "default" : tier } : {}), updatedAt: "2026-10-12T04:33:41Z",
  }])) as Partial<Record<import("./index.ts").ServiceTier, ProbeTierObservation>>;
}

import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-provider-service-tier-"));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const openAIModel = {
  provider: "openai",
  authMode: "api_key",
  id: "gpt-5.5",
  api: "openai-responses",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

const codexModel = {
  provider: "openai-codex",
  authMode: "api_key",
  id: "gpt-5.5",
  api: "openai-codex-responses",
  maxTokens: 128000,
  reasoning: true,
  thinkingLevelMap: { high: "high" },
} as never;

const ultrafastModel = {
  ...openAIModel as object,
  provider: "openai",
  id: "gpt-6-astra",
  api: "openai-responses",
} as never;

const MANUAL_TEST_TIERS: ServiceTier[] = ["priority", "flex", "default", "auto", "fast"];
function manualEntry(model: { provider: string; id: string; api?: string }, tiers: ServiceTier[] = MANUAL_TEST_TIERS): ServiceTierMapEntry {
  return { ...model, authMode: "api_key", determined: true, tiers: [...tiers], source: "manual", updatedAt: "fixture" };
}

const API_KEY_AUTH = {
  hasConfiguredAuth: () => true,
  isUsingOAuth: () => false,
  getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
};

// Explicit known-auth fixtures, never production migration of historical data.
function fixtureMap(value: { entries: Record<string, ServiceTierMapEntry> }): ServiceTierMapFile {
  return Object.values(value.entries).reduce((map, entry) => putRoute(map, entry), { version: 3, entries: {} } as ServiceTierMapFile);
}
function writeFixtureMap(path: string, value: unknown): void {
  const input = value as { entries?: Record<string, ServiceTierMapEntry> };
  const entries = input?.entries;
  if (entries && Object.values(entries).every((entry) => entry && !entry.routes && entry.authMode === "api_key")) writeMap(path, fixtureMap({ entries }));
  else writeMap(path, value);
}

// Stored entries for removed providers are retained, but their runtime features are blocked.
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

const unknownRouterModel = {
  ...openAIModel as object,
  provider: "openrouter",
  id: "unverified-model",
  api: "openai-completions",
} as never;

const blockedModels = [
  { provider: "anthropic", api: "anthropic-messages" },
  { provider: "google", api: "google-generative-ai" },
  { provider: "google-vertex", api: "google-vertex" },
  { provider: "amazon-bedrock", api: "bedrock-converse-stream" },
  { provider: "bedrock", api: "openai-completions" },
  { provider: "gemini", api: "openai-completions" },
  { provider: "anthropic", api: "openai-responses" },
  { provider: "openai", api: "anthropic-messages" },
  { provider: "openai", api: "google-generative-ai" },
  { provider: "openai", api: "bedrock-converse-stream" },
  { provider: "custom-provider", api: "openai-completions" },
  { provider: "constructor", api: "openai-completions" },
].map((identity) => ({ ...openAIModel as object, ...identity, id: "blocked-model" } as never));
blockedModels.push(opencodeQwenModel, opencodeMinimaxModel);

function createExtensionHarness(cwd: string, home: string, model: never = openAIModel, available: never[] = [openAIModel]) {
  type Command = {
    description: string;
    handler: (args: string, ctx: never) => Promise<void> | void;
    getArgumentCompletions?: (prefix: string) => unknown;
  };
  const commands = new Map<string, Command>();
  const autocompleteProviders: Array<Parameters<ExtensionContext["ui"]["addAutocompleteProvider"]>[0]> = [];
  const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown> | unknown>();
  const notifications: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const selections: string[] = [];
  const prompts: string[] = [];
  const selectionRequests: Array<{ message: string; options: string[] }> = [];
  let authMode: AuthMode = "api_key";
  const ctx = {
    cwd,
    model,
    mode: "tui",
    hasUI: true,
    modelRegistry: { ...API_KEY_AUTH,
      hasConfiguredAuth: () => authMode !== "unknown",
      isUsingOAuth: () => authMode === "oauth",
      getProviderAuthStatus: () => ({ configured: authMode !== "unknown", source: "stored" }),
      getAvailable: () => available,
    },
    ui: {
      notify: (message: string, type?: string) => {
        assert.match(message, /^\[pi-provider-service-tier(?: v[^\]]+)?\] /);
        notifications.push({ message, type });
      },
      setStatus: (key: string, value: string | undefined) => {
        assert.equal(value?.includes("pi-provider-service-tier") ?? false, false, "Footer status must remain compact");
        statuses.push({ key, value });
      },
      addAutocompleteProvider: (factory: typeof autocompleteProviders[number]) => autocompleteProviders.push(factory),
      select: async (message: string, options: string[]) => {
        assert.match(message, /^\[pi-provider-service-tier\] /);
        prompts.push(message);
        selectionRequests.push({ message, options: [...options] });
        return selections.shift();
      },
    },
  } as never;
  const pi = {
    registerCommand: (name: string, options: Command) => {
      assert.match(options.description, /^\[pi-provider-service-tier\] /);
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
    prompts,
    selectionRequests,
    autocompleteProviders,
    setAuthMode: (next: AuthMode) => { authMode = next; },
    setModel: (next: never) => { (ctx as { model: never }).model = next; },
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

test("recognizes known service tiers", () => {
  for (const tier of SERVICE_TIERS) assert.equal(isServiceTier(tier), true);
  assert.equal(isServiceTier("fast"), true);
  assert.equal(isServiceTier("ultrafast"), true);
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
    assert.equal(readMap(paths.map)?.version, 3);
    assert.deepEqual(readConfig(paths.project)?.entries, {});
    assert.deepEqual(readMap(paths.map)?.entries, {});
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects malformed JSON while normalizing invalid per-model entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.user), { recursive: true });
    writeFileSync(paths.user, "{ bad json", "utf8");
    assert.throws(() => readConfig(paths.user), ConfigFileError);

    writeFileSync(
      paths.user,
      JSON.stringify({
        aggressiveProbe: true,
        entries: { "bad": { active: true }, "openai/gpt-5.5": { active: true, serviceTier: "turbo" } },
      }),
      "utf8",
    );
    const config = readConfig(paths.user);
    assert.equal(config?.unknownModelBehavior, undefined);
    assert.deepEqual(config?.entries, { "openai/gpt-5.5": { active: false } });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("fast and ultrafast survive config and support-map round trips", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    for (const tier of ["fast", "ultrafast"] as const) {
      setScopedEntry(paths, "project", "openai/gpt-6-astra", { active: true, serviceTier: tier });
      assert.equal(readConfig(paths.project)?.entries?.["openai/gpt-6-astra"].serviceTier, tier);
    }
    writeFixtureMap(paths.map, { entries: { "openai/gpt-6-astra": manualEntry(ultrafastModel, ["fast", "ultrafast"]) } });
    const map = readMap(paths.map);
    assert.equal(mapSupportsTier(map, "openai/gpt-6-astra", "fast", ultrafastModel), true);
    assert.equal(mapSupportsTier(map, "openai/gpt-6-astra", "ultrafast", ultrafastModel), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("merges user and project config by provider/model key", () => {
  const paths = configPaths("/repo", "/home/user");
  const userConfig: ConfigFile = {
    unknownModelBehavior: "auto-probe",
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
  assert.equal(effective.unknownModelBehavior, "auto-probe");
  assert.deepEqual(effective.entries["openai/gpt-5.5"], { active: false, serviceTier: "flex" });
  assert.deepEqual(effective.entries["openai/gpt-4.1"], { active: true, serviceTier: "priority" });
});

test("active entries without any configured tier stay off without an implicit priority", () => {
  const paths = configPaths("/repo", "/home/user");
  const key = modelKey(openAIModel)!;
  const activeOnly = { entries: { [key]: { active: true } } };
  for (const [user, project] of [[activeOnly, undefined], [undefined, activeOnly], [activeOnly, activeOnly]]) {
    const config = mergeConfigs(user, project, paths);
    assert.deepEqual(config.entries[key], { active: false });
    assert.equal(configuredTierForModel(config, openAIModel), undefined);
    assert.equal(_test.statusText(config, { entries: {} }, openAIModel), "service_tier: ○ off");
  }
});

test("invalid explicit tiers disable entries instead of defaulting or reviving user tiers", () => {
  const paths = configPaths("/repo", "/home/user");
  const key = modelKey(openAIModel)!;
  const validUser = { entries: { [key]: { active: true, serviceTier: "flex" as const } } };
  for (const serviceTier of ["fleex", "off", "standard_only", "PRIORITY", "", null, undefined, 0, true, [], {}]) {
    const invalid = { entries: { [key]: { active: true, serviceTier } } } as unknown as ConfigFile;
    assert.deepEqual(mergeConfigs(invalid, undefined, paths).entries[key], { active: false });
    const overridden = mergeConfigs(validUser, invalid, paths);
    assert.deepEqual(overridden.entries[key], { active: false, serviceTier: "flex" });
    assert.equal(configuredTierForModel(overridden, openAIModel), undefined);
  }
});

test("malformed project entries and active flags cannot revive enabled user settings", () => {
  const paths = configPaths("/repo", "/home/user");
  const key = modelKey(openAIModel)!;
  const user = { entries: { [key]: { active: true, serviceTier: "priority" as const } } };
  for (const entry of [null, undefined, true, 7, "priority", [], ...[null, "true", 1, [], {}].map((active) => ({ active, serviceTier: "flex" }))]) {
    const project = { entries: { [key]: entry } } as unknown as ConfigFile;
    const config = mergeConfigs(user, project, paths);
    assert.equal(config.entries[key].active, false);
    assert.equal(configuredTierForModel(config, openAIModel), undefined);
  }
});

test("partial scope overrides can still inherit an explicitly configured valid tier", () => {
  const paths = configPaths("/repo", "/home/user");
  const key = modelKey(openAIModel)!;
  for (const serviceTier of SERVICE_TIERS) {
    const user = { entries: { [key]: { active: false, serviceTier } } };
    const project = { entries: { [key]: { active: true } } };
    const config = mergeConfigs(user, project, paths);
    assert.deepEqual(config.entries[key], { active: true, serviceTier });
    assert.equal(configuredTierForModel(config, openAIModel), serviceTier);
  }
});

test("tier lookup and status reject missing or invalid tiers even without config normalization", () => {
  const key = modelKey(openAIModel)!;
  const base = mergeConfigs(undefined, undefined, configPaths("/repo", "/home/user"));
  for (const serviceTier of [undefined, "fleex", "", null, 0, true, [], {}]) {
    const config = { ...base, entries: { [key]: { active: true, serviceTier } } } as unknown as typeof base;
    assert.equal(configuredTierForModel(config, openAIModel), undefined);
    assert.equal(_test.statusText(config, { entries: {} }, openAIModel), "service_tier: ○ off");
  }
});

test("project unknown behavior overrides user unknown behavior", () => {
  const paths = configPaths("/repo", "/home/user");
  assert.equal(
    mergeConfigs({ unknownModelBehavior: "auto-probe" }, { unknownModelBehavior: "leave-unknown" }, paths)
      .unknownModelBehavior,
    "leave-unknown",
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
    setScopedUnknownModelBehavior(paths, "project", "auto-probe");
    const config = readConfig(paths.project);
    assert.equal(config?.unknownModelBehavior, "auto-probe");
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
    const rawBeforeStartup = JSON.parse(readFileSync(paths.user, "utf8")) as Record<string, unknown>;
    assert.equal(rawBeforeStartup.version, 1);
    assert.equal(rawBeforeStartup.aggressiveProbe, true);
    _test.migrateStartupFiles(paths);
    const rawAfterStartup = JSON.parse(readFileSync(paths.user, "utf8")) as Record<string, unknown>;
    assert.equal(rawAfterStartup.version, 2);
    assert.equal("aggressiveProbe" in rawAfterStartup, false);
    writeConfig(paths.user, config ?? {});
    const written = readConfig(paths.user);
    assert.equal(written?.version, 2);
    assert.equal(written?.unknownModelBehavior, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("migrates v1 map by renaming supported to determined and preserving unknown entries", () => {
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
          "openai/gpt-5.5": manualEntry(openAIModel),
          "openai/gpt-legacy": {
            provider: "openai",
            id: "gpt-legacy",
            api: "openai-responses",
            supported: true,
            tiers: ["priority"],
            source: "manual",
            updatedAt: new Date().toISOString(),
          },
          "openai/gpt-old": {
            provider: "openai",
            id: "gpt-old",
            determined: false,
            tiers: [],
            source: "error",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const map = readMap(paths.map);
    assert.equal(map?.version, 3);
    assert.equal(Boolean(map?.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.unknown), true);
    assert.equal(map?.entries?.["openai/gpt-legacy"]?.routes["openai-responses"]?.auth.unknown?.determined, true);
    assert.equal("supported" in (map?.entries?.["openai/gpt-legacy"]?.routes["openai-responses"] ?? {}), false);
    assert.equal((map?.entries?.["openai/gpt-old"]?.legacy?.[0] as Record<string, unknown>).determined, false);
    assert.equal((map?.entries?.["openai/gpt-old"]?.legacy?.[0] as Record<string, unknown>).source, "error");
    const rawBeforeStartup = JSON.parse(readFileSync(paths.map, "utf8")) as { version?: number; entries?: Record<string, Record<string, unknown>> };
    assert.equal(rawBeforeStartup.version, 1);
    assert.equal(rawBeforeStartup.entries?.["openai/gpt-legacy"]?.supported, true);
    _test.migrateStartupFiles(paths);
    const rawAfterStartup = JSON.parse(readFileSync(paths.map, "utf8")) as ServiceTierMapFile;
    assert.equal(rawAfterStartup.version, 3);
    assert.equal(rawAfterStartup.entries?.["openai/gpt-legacy"]?.routes["openai-responses"]?.auth.unknown?.determined, true);
    assert.equal("supported" in (rawAfterStartup.entries?.["openai/gpt-legacy"]?.routes["openai-responses"] ?? {}), false);
    assert.equal((rawAfterStartup.entries?.["openai/gpt-old"]?.legacy?.[0] as Record<string, unknown>).determined, false);
    assert.equal((rawAfterStartup.entries?.["openai/gpt-old"]?.legacy?.[0] as Record<string, unknown>).source, "error");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("package no longer loads, exports or publishes bundled support presets", async () => {
  const runtime = await import("./index.ts");
  assert.equal("buildPresetMapEntry" in runtime, false);
  assert.equal("presetTiersForModel" in runtime, false);
  assert.equal(existsSync(new URL("../presets", import.meta.url)), false);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.files.some((path: string) => path.startsWith("presets/")), false);
});

test("preset-removal notice identifies the current extension version from package metadata", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(_test.PRESET_REMOVAL_NOTICE.startsWith(`[${pkg.name} v${pkg.version}] Removed legacy preset information.`));
});

test("injects only when active and map-supported", () => {
  const paths = configPaths("/repo", "/home/user");
  const config = mergeConfigs(
    { entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } },
    undefined,
    paths,
  );
  const map = fixtureMap({ entries: { "openai/gpt-5.5": manualEntry(openAIModel) } });
  assert.equal(resolveTierForModel(config, map, openAIModel), "priority");
  assert.equal(mapSupportsTier(map, "openai/gpt-5.5", "priority", openAIModel), true);

  const offConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: false, serviceTier: "priority" } } }, undefined, paths);
  assert.equal(resolveTierForModel(offConfig, map, openAIModel), undefined);

  const unsupportedConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "flex" } } }, undefined, paths);
  const priorityOnlyEntry = manualEntry(openAIModel);
  priorityOnlyEntry.tiers = ["priority"];
  priorityOnlyEntry.determined = true;
  const codexMap = fixtureMap({ entries: { "openai/gpt-5.5": priorityOnlyEntry } });
  assert.equal(resolveTierForModel(unsupportedConfig, codexMap, openAIModel), undefined);
});

test("default minimal status omits provider/model key and evidence labels", () => {
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    const paths = configPaths("/repo", "/home/user");
    const config = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } }, undefined, paths);
    const map = fixtureMap({ entries: { "openai/gpt-5.5": manualEntry(openAIModel) } });
    assert.equal(_test.statusText(config, map, openAIModel), "service_tier: ⚡ priority");
    assert.equal(_test.statusText(config, { entries: {} }, openAIModel), "service_tier: ⚡ priority");
    const flexConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "flex" } } }, undefined, paths);
    assert.equal(_test.statusText(flexConfig, map, openAIModel), "service_tier: ● flex");
    const offConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: false, serviceTier: "priority" } } }, undefined, paths);
    assert.equal(_test.statusText(offConfig, map, openAIModel), "service_tier: ○ off");
    const unsetConfig = mergeConfigs(undefined, undefined, paths);
    assert.equal(_test.statusText(unsetConfig, map, openAIModel), "service_tier: ○ off");
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test("status text does not yellow-highlight off or unknown states", () => {
  const paths = configPaths("/repo", "/home/user");
  const offConfig = mergeConfigs(undefined, undefined, paths);
  assert.equal(_test.statusText(offConfig, { entries: {} }, openAIModel), "service_tier: ○ off");
  const unknownConfig = mergeConfigs({ entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } }, undefined, paths);
  assert.equal(_test.statusText(unknownConfig, { entries: {} }, openAIModel), "service_tier: ⚡ priority");
});

test("statusFormat is optional, inherited field-wise and preserved by migration and unrelated writes", () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  try {
    assert.equal(Object.hasOwn(mergeConfigs(undefined, undefined, paths), "statusFormat"), false);
    setScopedStatusFormat(paths, "user", "{symbol} {tier}");
    assert.equal(existsSync(paths.project), false); assert.equal(existsSync(paths.map), false);
    assert.equal(resolveEffectiveConfig(cwd, home).statusFormat, "{symbol} {tier}");
    setScopedEntry(paths, "user", modelKey(openAIModel)!, { active: true, serviceTier: "priority", custom: "keep" });
    setScopedStatusFormat(paths, "project", "");
    assert.equal(resolveEffectiveConfig(cwd, home).statusFormat, "");
    setScopedStatusFormat(paths, "project", undefined);
    assert.equal(resolveEffectiveConfig(cwd, home).statusFormat, "{symbol} {tier}");
    assert.deepEqual(readConfig(paths.user)?.entries?.[modelKey(openAIModel)!], { active: true, serviceTier: "priority", custom: "keep" });
    assert.equal(_test.migrateConfigToCurrent({ version: 1, statusFormat: "{tier}", entries: {} }).statusFormat, "{tier}");
    assert.equal(Object.hasOwn(_test.migrateConfigToCurrent({ version: 1, entries: {} }), "statusFormat"), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("custom footer segments preserve evidence meanings, off/error safety and verified-only coloring", () => {
  const paths = configPaths("/repo", "/home"), map = pickerFixtureMap();
  const config = (tier: ServiceTier, statusFormat: string) => mergeConfigs({ statusFormat, entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: tier } } }, undefined, paths);
  const oldColor = process.env.NO_COLOR;
  try {
    process.env.NO_COLOR = "1";
    assert.equal(_test.statusText(config("priority", "{tier} | {symbol} | {support}"), map, openAIModel), "priority | ⚡ | fallback");
    assert.equal(_test.statusText(config("priority", "등급: {symbol} {tier} | {support} | {fallback}"), map, openAIModel), "등급: ⚡ priority | fallback | default");
    assert.equal(_test.statusText(config("priority", "{fallback}"), map, openAIModel), "default");
    for (const tier of ["flex", "fast", "default", "auto", "scale"] as const) {
      assert.equal(_test.statusText(config(tier, "{fallback}"), map, openAIModel), undefined);
    }
    assert.equal(_test.statusText(config("flex", "{label} {tier} {support}"), map, openAIModel), "service_tier flex probe-verified");
    assert.equal(_test.statusText(config("fast", "{tier} {support}"), map, openAIModel), "fast manual");
    assert.equal(_test.statusText(config("default", "{support}"), map, openAIModel), "probe-completed (tier unknown)");
    assert.equal(_test.statusText(config("scale", "{support}"), map, openAIModel), "unknown");
    assert.equal(_test.statusText(mergeConfigs({ statusFormat: "{symbol} {tier}", entries: {} }, undefined, paths), map, openAIModel), "○ off");
    assert.equal(_test.statusText(mergeConfigs({ statusFormat: "{support}{fallback}", entries: {} }, undefined, paths), map, openAIModel), undefined);
    assert.equal(_test.statusText(config("priority", ""), map, openAIModel), undefined);
    assert.equal(_test.statusText({ ...config("priority", ""), configIssues: [{ path: paths.user, reason: "json" }] }, map, openAIModel), "service_tier ○ off (config error)");
    assert.equal(_test.statusText(config("priority", "{tier}"), map, blockedModels[0]), undefined);
    delete process.env.NO_COLOR;
    assert.match(_test.statusText(config("flex", "{tier}"), map, openAIModel)!, /^\u001b\[32mflex/);
    assert.equal(_test.statusText(config("priority", "{tier}"), map, openAIModel), "priority");
  } finally { if (oldColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldColor; }
});

test("status-format command creates only an explicitly saved user config and keeps status/reset/invalid input read-only", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    const command = harness.commands.get("service-tier-status-format")!;
    for (const arg of ["", "status", "reset", "{bad}", '"unclosed', "a\nb", '{"\\n"support}', '{" | "unknown}']) {
      await command.handler(arg, harness.ctx);
      assert.deepEqual(Object.values(paths).map(path => existsSync(path)), [false, false, false]);
    }
    await command.handler('"{symbol} {tier}"', harness.ctx);
    assert.equal(readConfig(paths.user)?.statusFormat, "{symbol} {tier}");
    assert.deepEqual(readConfig(paths.user)?.entries, {});
    assert.equal(existsSync(paths.project), false); assert.equal(existsSync(paths.map), false);
    assert.equal(harness.statuses.at(-1)?.value, "○ off");
    const before = readFileSync(paths.user, "utf8");
    await command.handler("{bad}", harness.ctx);
    assert.equal(readFileSync(paths.user, "utf8"), before);
    await command.handler('""', harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, undefined);
    await command.handler("reset", harness.ctx);
    assert.equal(Object.hasOwn(readConfig(paths.user)!, "statusFormat"), false);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    assert.equal(harness.prompts.length, 0); assert.equal(existsSync(paths.map), false);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("conditional formats save directly or JSON-quoted without rewriting legacy settings or support", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    const original: ConfigFile = {
      version: 2, unknownModelBehavior: "auto-probe", custom: "keep",
      statusFormat: "{tier} | {support} | {fallback}",
      entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } },
    };
    writeConfig(paths.user, original);
    writeMap(paths.map, pickerFixtureMap());
    const legacyBytes = readFileSync(paths.user, "utf8");
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(readFileSync(paths.user, "utf8"), legacyBytes);
    const mapBytes = readFileSync(paths.map, "utf8");
    const command = harness.commands.get("service-tier-status-format")!;
    const format = 'Tier: {symbol} {tier}{" | "support}{" → "fallback}';
    for (const arg of [format, JSON.stringify(format)]) {
      await command.handler(arg, harness.ctx);
      assert.deepEqual(readConfig(paths.user), { ...original, statusFormat: format });
      assert.equal(harness.statuses.at(-1)?.value, "Tier: ⚡ priority | fallback → default");
      assert.equal(existsSync(paths.project), false);
      assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    }
    const savedBytes = readFileSync(paths.user, "utf8");
    for (const arg of ['{"\\n"support}', '{" | "unknown}']) {
      await command.handler(arg, harness.ctx);
      assert.equal(readFileSync(paths.user, "utf8"), savedBytes);
    }
    writeConfig(paths.user, { ...readConfig(paths.user), entries: { [modelKey(openAIModel)!]: { active: false, serviceTier: "priority" } } });
    const payload = { model: "fixture", service_tier: "default" };
    assert.equal(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), undefined);
    assert.equal(harness.statuses.at(-1)?.value, "Tier: ○ off");
    assert.deepEqual(payload, { model: "fixture", service_tier: "default" });
    setScopedStatusFormat(paths, "project", 'Project: {tier}{" | "support}');
    const projectBytes = readFileSync(paths.project, "utf8");
    await command.handler(format, harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, "Project: off");
    assert.equal(readFileSync(paths.project, "utf8"), projectBytes);
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    assert.equal(harness.prompts.length, 0);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("fresh startup leaves both settings files absent and manual format edits refresh an unchanged active tier", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(existsSync(paths.user), false); assert.equal(existsSync(paths.project), false);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    writeConfig(paths.user, { statusFormat: "{symbol} {tier}", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    const original = { model: "fixture", service_tier: "default" };
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { ...original, service_tier: "priority" });
    assert.equal(harness.statuses.at(-1)?.value, "⚡ priority");
    const mapBytes = readFileSync(paths.map, "utf8");
    await harness.commands.get("service-tier-status-format")?.handler("Tier: {symbol} {tier} | {support}", harness.ctx);
    assert.equal(readConfig(paths.user)?.statusFormat, "Tier: {symbol} {tier} | {support}");
    assert.equal(harness.statuses.at(-1)?.value, "Tier: ⚡ priority | unknown");
    writeConfig(paths.user, { ...readConfig(paths.user), statusFormat: "T={tier}; {support}" });
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { ...original, service_tier: "priority" });
    assert.equal(harness.statuses.at(-1)?.value, "T=priority; unknown");
    assert.deepEqual(original, { model: "fixture", service_tier: "default" });
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    assert.equal(harness.prompts.length, 0);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("status presets wrap user formats, preserve settings/evidence and respect project overrides", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  let probes = 0;
  const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    const command = harness.commands.get("service-tier-status-preset")!;
    assert.ok(command.description.includes("minimal (default)"));
    for (const arg of ["", "status", "invalid", "constructor", "__proto__"]) {
      await command.handler(arg, harness.ctx);
      assert.deepEqual(Object.values(paths).map(path => existsSync(path)), [false, false, false]);
    }
    assert.ok(harness.notifications.some(({ message }) => message.includes('Footer statusFormat: minimal (default) "{label}: {symbol} {tier}".')));
    assert.ok(harness.notifications.some(({ message, type }) => type === "error" && message.includes("minimal (default) saves the default template")));
    for (const line of [
      "minimal (default): {label}: {symbol} {tier}",
      'medium: {label}: {symbol} {tier}{" | "support}',
      'long: {label}: {symbol} {tier}{" | "support}{" → "fallback}',
    ]) {
      assert.ok(harness.notifications.some(({ message }) => message.split("\n").includes(line)), line);
    }
    await command.handler("long", harness.ctx);
    assert.equal(readConfig(paths.user)?.statusFormat, '{label}: {symbol} {tier}{" | "support}{" → "fallback}');
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    assert.equal(existsSync(paths.project), false); assert.equal(existsSync(paths.map), false);
    const original: ConfigFile = {
      version: 2, unknownModelBehavior: "auto-probe", custom: "keep",
      entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } },
    };
    writeConfig(paths.user, original);
    writeMap(paths.map, pickerFixtureMap());
    const mapBytes = readFileSync(paths.map, "utf8");
    for (const [preset, format, text] of [
      ["minimal", "{label}: {symbol} {tier}", "service_tier: ⚡ priority"],
      ["medium", '{label}: {symbol} {tier}{" | "support}', "service_tier: ⚡ priority | fallback"],
      ["long", '{label}: {symbol} {tier}{" | "support}{" → "fallback}', "service_tier: ⚡ priority | fallback → default"],
    ] as const) {
      await command.handler(preset, harness.ctx);
      assert.deepEqual(readConfig(paths.user), { ...original, statusFormat: format });
      assert.equal(harness.statuses.at(-1)?.value, text);
      assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
      assert.equal(existsSync(paths.project), false);
    }
    const explicitLongText = harness.statuses.at(-1)?.value;
    await harness.commands.get("service-tier-status-format")?.handler("reset", harness.ctx);
    assert.deepEqual(readConfig(paths.user), original);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.notEqual(harness.statuses.at(-1)?.value, explicitLongText);
    setScopedStatusFormat(paths, "project", "Project: {tier} | {support} | {fallback}");
    const projectBytes = readFileSync(paths.project, "utf8");
    for (const preset of ["minimal", "medium", "long"]) {
      await command.handler(preset, harness.ctx);
      assert.equal(harness.statuses.at(-1)?.value, "Project: priority | fallback | default");
      assert.equal(readFileSync(paths.project, "utf8"), projectBytes);
    }
    const userBytes = readFileSync(paths.user, "utf8");
    for (const arg of ["", "status", "invalid", "constructor", "__proto__"]) await command.handler(arg, harness.ctx);
    assert.equal(readFileSync(paths.user, "utf8"), userBytes);
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    assert.equal(probes, 0); assert.equal(harness.prompts.length, 0);
  } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("invalid statusFormat files fail closed without reviving another scope or hiding config errors", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    writeConfig(paths.user, { statusFormat: "", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    mkdirSync(dirname(paths.project), { recursive: true });
    for (const value of [null, 3, "{unknown}", "{tier", "\u001b[31m", "line\nbreak", "x".repeat(257), '{"\\u001b"support}', '{"\\q"support}', '{" | "unknown}']) {
      const bytes = JSON.stringify({ version: 2, statusFormat: value, custom: "private-format-marker", entries: {} });
      writeFileSync(paths.project, bytes);
      await harness.handlers.get("session_start")?.({} as never, harness.ctx);
      assert.equal(harness.statuses.at(-1)?.value, "service_tier ○ off (config error)");
      assert.equal(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), undefined);
      await harness.commands.get("service-tier-status-format")?.handler("reset", harness.ctx);
      await harness.commands.get("service-tier-status-preset")?.handler("minimal", harness.ctx);
      assert.equal(harness.statuses.at(-1)?.value, "service_tier ○ off (config error)");
      assert.throws(() => setScopedStatusFormat(paths, "project", "{tier}"), ConfigFileError);
      assert.equal(readFileSync(paths.project, "utf8"), bytes);
      assert.ok(harness.notifications.every(({ message }) => !message.includes("private-format-marker")));
    }
    assert.equal(existsSync(paths.map), false); assert.equal(harness.prompts.length, 0);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("changing the footer format or preset neither starts nor cancels probes and leaves temporary Probe progress unchanged", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home), release = deferred<"supported">();
  let calls = 0; let signal: AbortSignal | undefined;
  const restoreProbe = _test.setProbeTierForTest(async (_model, _tier, _ctx, currentSignal) => {
    calls++; signal = currentSignal; return calls === 1 ? release.promise : "supported";
  });
  try {
    writeConfig(paths.user, { unknownModelBehavior: "auto-probe", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(calls, 0);
    await harness.commands.get("service-tier-status-format")?.handler("T {tier} {support}", harness.ctx);
    assert.equal(calls, 0);
    void _test.startAutoProbeForCurrentTier(harness.ctx, modelKey(openAIModel)!, "priority");
    assert.equal(calls, 1);
    const progress = harness.statuses.at(-1)?.value;
    assert.match(progress!, /^service_tier .*probing/);
    await harness.commands.get("service-tier-status-preset")?.handler("medium", harness.ctx);
    assert.equal(calls, 1); assert.equal(signal?.aborted, false);
    assert.equal(harness.statuses.at(-1)?.value, progress);
    release.resolve("supported"); await expectAutoProbesToSettle();
    assert.equal(harness.statuses.at(-1)?.value?.replace(/\u001b\[[0-9;]*m/g, ""), "service_tier: ⚡ priority | probe-verified");
    assert.deepEqual(readConfig(paths.user)?.entries?.[modelKey(openAIModel)!], { active: true, serviceTier: "priority" });
  } finally {
    release.resolve("supported"); await harness.handlers.get("session_shutdown")?.({} as never, harness.ctx); await expectAutoProbesToSettle();
    restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
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

  const map = fixtureMap({ entries: { "openai/gpt-5.5": manualEntry(openAIModel) } });
  const next = markTierUnsupported(map, "openai/gpt-5.5", "priority", "service_tier unsupported", openAIModel);
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.tiers.includes("priority"), false);
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.unsupportedTiers?.includes("priority"), true);
  assert.equal(mapSupportState(next, "openai/gpt-5.5", "priority", openAIModel), "unknown");
  assert.equal(mapSupportState({ entries: {} }, "openai/gpt-5.5", "priority", openAIModel), "unknown");
});

test("manual support marking is not probe verification", () => {
  const map = markTierUnsupported({ entries: {} }, "openai/gpt-5.5", "priority", undefined, openAIModel);
  const next = markTierSupported(map, "openai/gpt-5.5", "priority", openAIModel);
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.determined, false);
  assert.deepEqual(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.tiers, ["priority"]);
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.unsupportedTiers?.includes("priority") ?? false, false);
});

test("marks auto-probe results with complete probe metadata", () => {
  const manualMap = fixtureMap({ entries: { "openai/gpt-5.5": manualEntry(openAIModel) } });
  const next = markTierProbeResults(
    manualMap,
    "openai/gpt-5.5",
    fixtureResults({ priority: "supported", flex: "unsupported", default: "supported", auto: "unsupported", scale: "unsupported", fast: "unsupported", ultrafast: "unsupported" }, openAIModel),
    openAIModel,
    "probe rejected: flex, auto, scale",
  );
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.provider, "openai");
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.id, "gpt-5.5");
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.api, "openai-responses");
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.source, "probe");
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.error, "probe rejected: flex, auto, scale");
  assert.equal(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.determined, true);
  assert.deepEqual(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.tiers, ["priority", "default"]);
  assert.deepEqual(next.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.unsupportedTiers, ["flex", "auto", "scale", "fast", "ultrafast"]);
});

test("default probe uses Pi's configured model registry with a raw Context and tier payload hook", async () => {
  let calls = 0;
  let payload: unknown;
  const originalPayload = { model: "gpt-6-astra", service_tier: "default" };
  const ctx = {
    modelRegistry: { ...API_KEY_AUTH,
      getApiKeyAndHeaders: () => { throw new Error("Probe must not resolve request auth twice"); },
      streamSimple(model: unknown, context: { messages: Array<{ role: string; content: string }> }, options: SimpleStreamOptions) {
        calls++;
        assert.equal(model, ultrafastModel);
        assert.equal(context.messages[0].role, "user");
        assert.equal(context.messages[0].content, "Reply OK.");
        assert.equal(options.maxTokens, 1);
        assert.equal(options.signal?.aborted, false);
        assert.equal(options.apiKey, undefined);
        assert.equal(options.headers, undefined);
        return (async function* () {
          payload = await options.onPayload?.(originalPayload, ultrafastModel);
          await options.onProviderStreamEvent?.({ type: "response.completed", response: { service_tier: "ultrafast" } }, ultrafastModel);
          yield { type: "done" };
        })();
      },
    },
  } as never;
  assert.equal((await _test.defaultProbeTier(ultrafastModel, "ultrafast", ctx)).result, "supported");
  assert.equal(calls, 1);
  assert.deepEqual(payload, { model: "gpt-6-astra", service_tier: "ultrafast" });
  assert.deepEqual(originalPayload, { model: "gpt-6-astra", service_tier: "default" });
});

test("default probe classifies provider errors and incomplete streams without retrying", async () => {
  for (const [errorMessage, expected] of [
    ["Invalid service_tier: ultrafast", "unsupported"],
    ["Unauthorized", "unknown"],
    ["Rate limit exceeded", "unknown"],
    [undefined, "unknown"],
  ] as const) {
    let calls = 0;
    const ctx = {
      modelRegistry: { ...API_KEY_AUTH,
        streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
          calls++;
          return (async function* () {
            await options.onPayload?.({}, ultrafastModel);
            if (errorMessage) yield { type: "error", error: { errorMessage } };
          })();
        },
      },
    } as never;
    assert.equal((await _test.defaultProbeTier(ultrafastModel, "ultrafast", ctx)).result, expected);
    assert.equal(calls, 1);
  }
  const ctx = { modelRegistry: { ...API_KEY_AUTH, streamSimple: () => { throw new Error("Unknown provider"); } } } as never;
  assert.equal((await _test.defaultProbeTier(ultrafastModel, "fast", ctx)).result, "unknown");
});

test("unknown behavior defaults to ask", () => {
  const effective = mergeConfigs(undefined, undefined, configPaths("/repo", "/home/user"));
  assert.equal(effective.unknownModelBehavior, "ask");
});

test("tier argument completions include fast and ultrafast", () => {
  assert.deepEqual(_test.tierCompletions("u"), [{ value: "ultrafast", label: "service_tier: ultrafast" }]);
  assert.deepEqual(_test.tierCompletions("fa"), [{ value: "fast", label: "service_tier: fast" }]);
  assert.equal(_test.tierCompletions("turbo"), null);
});

test("unknown behavior command exports completions", () => {
  assert.equal(_test.COMMAND_UNKNOWN_BEHAVIOR, "service-tier-unknown-behavior");
  assert.deepEqual(_test.unknownBehaviorCompletions("a"), [
    { value: "ask", label: "ask" },
    { value: "auto-probe", label: "auto-probe" },
  ]);
  assert.deepEqual(_test.unknownBehaviorCompletions("l"), [{ value: "leave-unknown", label: "leave-unknown" }]);
});

test("all command argument choices omit the extension prefix without changing values or files", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const bytes = Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined);
    const groups = [
      [["service-tier-project", "service-tier-user"], [...SERVICE_TIERS, "off", "status"]],
      [["service-tier-fast-project", "service-tier-fast-user", "fast-project", "fast-user", "service-tier-debug"], ["on", "off", "status"]],
      [["service-tier-unknown-behavior"], ["ask", "auto-probe", "leave-unknown", "status"]],
      [["service-tier-status-format"], ["status", "reset"]],
      [["service-tier-status-preset"], ["minimal", "medium", "long", "status"]],
    ] as const;
    for (const [commands, values] of groups) for (const command of commands) {
      assert.deepEqual(harness.commands.get(command)?.getArgumentCompletions?.(""), values.map(value => ({ value, label: isServiceTier(value) ? `service_tier: ${value}` : value === "minimal" ? "minimal (default)" : value })), command);
    }
    assert.equal(harness.prompts.length, 0);
    assert.deepEqual(Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined), bytes);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("TUI messages and dialog titles identify the extension while footer status stays compact", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const originalNotify = (harness.ctx as ExtensionCommandContext).ui.notify;
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    await harness.commands.get("service-tier-project")?.handler("turbo", harness.ctx);
    await harness.commands.get("service-tier-debug")?.handler("on", harness.ctx);
    await harness.commands.get("service-tier-unknown-behavior")?.handler("status", harness.ctx);
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /^\[pi-provider-service-tier\] service_tier=flex/);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ● flex");
    assert.ok(harness.notifications.some(({ type }) => type === "error"));
    assert.ok(harness.notifications.some(({ message }) => message.includes("unknownModelBehavior is")));
    const original = { model: "fixture" };
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { ...original, service_tier: "flex" });
    assert.deepEqual(original, { model: "fixture" });
    assert.ok(harness.notifications.some(({ message }) => message.includes("debug: injected")));
    assert.equal((harness.ctx as ExtensionCommandContext).ui.notify, originalNotify);
    for (const { message, type } of harness.notifications) {
      assert.match(message, /^\[pi-provider-service-tier\] /);
      assert.equal(type, message.includes("Usage:") ? "error" : "info");
    }
  } finally {
    await harness.handlers.get("session_shutdown")?.({} as never, harness.ctx);
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("plain completion labels preserve Pi insertion values and other providers' suggestions", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const external = { value: "original", label: "[other-extension] External label" };
    const tuiPath = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui");
    const { CombinedAutocompleteProvider } = await import(pathToFileURL(tuiPath).href);
    const native = new CombinedAutocompleteProvider([{ name: "unrelated", getArgumentCompletions: () => [external] }], cwd);
    const editor = harness.autocompleteProviders[0](native);
    const options = { signal: new AbortController().signal };
    for (const [command, prefix, value] of [
      ["service-tier-project", "u", "ultrafast"], ["service-tier-user", "fa", "fast"],
      ["service-tier-fast-project", "on", "on"], ["service-tier-fast-user", "off", "off"],
      ["fast-project", "sta", "status"], ["fast-user", "on", "on"],
      ["service-tier-unknown-behavior", "auto", "auto-probe"], ["service-tier-debug", "sta", "status"],
      ["service-tier-status-format", "res", "reset"],
      ["service-tier-status-preset", "min", "minimal"],
      ["service-tier-status-preset", "med", "medium"],
      ["service-tier-status-preset", "lo", "long"],
    ]) {
      const line = `/${command} ${prefix}`;
      const suggestions = await editor.getSuggestions([line], 0, line.length, options);
      assert.ok(suggestions);
      assert.deepEqual(suggestions.items, [{ value, label: isServiceTier(value) ? `service_tier: ${value}` : value === "minimal" ? "minimal (default)" : value }]);
      const completed = `/${command} ${value}`;
      assert.deepEqual(editor.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix), {
        lines: [completed], cursorLine: 0, cursorCol: completed.length,
      });
    }
    const other = "/unrelated ori";
    assert.deepEqual(await editor.getSuggestions([other], 0, other.length, options), { items: [external], prefix: "ori" });
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

function pickerFixtureMap(): ServiceTierMapFile {
  const key = modelKey(openAIModel)!;
  const base = { payloadPrepared: true, updatedAt: "picker-fixture" };
  return markTierProbeResults(putRoute({ entries: {} }, manualEntry(openAIModel, ["fast"])), key, {
    priority: { ...base, result: "unknown", kind: "fallback", requestCompleted: true, servedTier: "default" },
    flex: { ...base, result: "supported", kind: "verified", requestCompleted: true, servedTier: "flex" },
    default: { ...base, result: "unknown", kind: "request-completed", requestCompleted: true },
    auto: { ...base, result: "unsupported", kind: "rejected", requestCompleted: false },
  }, openAIModel);
}

for (const scope of ["project", "user"] as const) {
  test(`${scope} tier picker explains symbols and cancels without creating or migrating files or probing`, async () => {
    for (const existing of [false, true]) {
      const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
      const harness = createExtensionHarness(cwd, home);
      let probes = 0;
      const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
      try {
        if (existing) {
          mkdirSync(dirname(paths.user), { recursive: true });
          writeFileSync(paths.user, JSON.stringify({ version: 1, unknownModelBehavior: "auto-probe", custom: "keep", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } }));
          writeFileSync(paths.map, JSON.stringify({ version: 2, entries: { [modelKey(openAIModel)!]: { ...openAIModel as object, determined: true, source: "probe", tiers: ["priority"] } } }));
        }
        const bytes = Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined);
        await harness.commands.get(`service-tier-${scope}`)?.handler("  ", harness.ctx);
        assert.equal(probes, 0);
        assert.equal(harness.selectionRequests.length, 1);
        const request = harness.selectionRequests[0];
        assert.match(request.message, new RegExp(`Choose ${scope} service tier for openai/gpt-5.5`));
        assert.match(request.message, /API: openai-responses; auth: api_key/);
        assert.ok(request.message.includes(TIER_PICKER_LEGEND));
        assert.deepEqual(request.options, tierChoices(undefined, openAIModel).map(({ label }) => label));
        assert.equal(harness.notifications.at(-1)?.type, "info");
        assert.match(harness.notifications.at(-1)!.message, /cancelled/);
        assert.deepEqual(Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined), bytes);
      } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
    }
  });

  test(`${scope} picker permits verified, unverified, fallback, rejected and manual tiers using raw config values`, async () => {
    for (const tier of ["priority", "flex", "default", "auto", "fast", "ultrafast"] as const) {
      const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
      const harness = createExtensionHarness(cwd, home);
      let probes = 0;
      const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
      try {
        writeConfig(paths.user, { unknownModelBehavior: "leave-unknown", custom: "keep", entries: {} });
        const map = pickerFixtureMap(); writeMap(paths.map, map);
        const mapBytes = readFileSync(paths.map, "utf8");
        harness.selections.push(tierChoices(map, openAIModel).find(item => item.value === tier)!.label);
        await harness.commands.get(`service-tier-${scope}`)?.handler("", harness.ctx);
        assert.deepEqual(readConfig(paths[scope])?.entries?.[modelKey(openAIModel)!], { active: true, serviceTier: tier });
        assert.equal(readConfig(paths.user)?.custom, "keep");
        assert.equal(harness.prompts.length, 1);
        assert.equal(probes, 0);
        assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
        if (tier === "auto") assert.ok(harness.notifications.some(({ type, message }) => type === "warning" && message.includes("not supported")));
        const original = { model: "fixture" };
        assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { ...original, service_tier: tier });
        assert.deepEqual(original, { model: "fixture" });
      } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
    }
  });
}

for (const policy of ["ask-leave", "ask-probe", "auto-probe"] as const) {
  test(`picker selection preserves ${policy} approval behavior; opening alone never probes`, async () => {
    const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
    const harness = createExtensionHarness(cwd, home, unknownRouterModel);
    let probes = 0;
    const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
    try {
      if (policy === "auto-probe") setScopedUnknownModelBehavior(paths, "user", "auto-probe");
      const bytes = existsSync(paths.user) ? readFileSync(paths.user, "utf8") : undefined;
      const select = (harness.ctx as ExtensionCommandContext).ui.select;
      (harness.ctx as ExtensionCommandContext).ui.select = async (title, options) => {
        if (title.includes("Choose project service tier")) {
          assert.equal(probes, 0);
          assert.equal(existsSync(paths.project), false);
          assert.equal(existsSync(paths.map), false);
          assert.equal(existsSync(paths.user) ? readFileSync(paths.user, "utf8") : undefined, bytes);
        }
        return select(title, options);
      };
      harness.selections.push(tierChoices(undefined, unknownRouterModel).find(item => item.value === "flex")!.label);
      if (policy !== "auto-probe") harness.selections.push(policy === "ask-probe" ? "Auto-probe once" : "Leave unknown once");
      await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
      await expectAutoProbesToSettle();
      assert.equal(probes, policy === "ask-leave" ? 0 : probeCandidates(unknownRouterModel).length);
      assert.equal(harness.prompts.length, policy === "auto-probe" ? 1 : 2);
      if (policy !== "auto-probe") {
        assert.match(harness.prompts[1], /may consume provider tokens/);
        assert.deepEqual(harness.selectionRequests[1].options, ["Auto-probe once", "Always auto-probe", "Leave unknown once", "Always leave unknown"]);
      }
      assert.deepEqual(readConfig(paths.project)?.entries?.[modelKey(unknownRouterModel)!], { active: true, serviceTier: "flex" });
    } finally {
      await expectAutoProbesToSettle();
      restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });
}

test("picker off cancels an owned probe and cannot save its late result", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  const release = deferred<"supported">(); let signal: AbortSignal | undefined;
  const restoreProbe = _test.setProbeTierForTest(async (_model, _tier, _ctx, currentSignal) => { signal = currentSignal; return release.promise; });
  try {
    writeConfig(paths.user, { unknownModelBehavior: "auto-probe", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    writeMap(paths.map, { entries: {} });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const mapBytes = readFileSync(paths.map, "utf8");
    void _test.startAutoProbeForCurrentTier(harness.ctx, modelKey(openAIModel)!, "priority");
    assert.ok(signal);
    harness.selections.push(tierChoices(undefined, openAIModel).find(item => item.value === "off")!.label);
    await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
    await expectAutoProbesToSettle();
    assert.equal(signal.aborted, true);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    assert.equal(readConfig(paths.project)?.entries?.[modelKey(openAIModel)!]?.active, false);
    release.resolve("supported"); await expectAutoProbesToSettle();
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
  } finally {
    release.resolve("supported"); await harness.handlers.get("session_shutdown")?.({} as never, harness.ctx); await expectAutoProbesToSettle();
    restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("picker status and headless no-argument status keep existing settings and never probe", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    writeConfig(paths.user, { entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    writeConfig(paths.project, { entries: {} }); writeMap(paths.map, pickerFixtureMap());
    const bytes = Object.values(paths).map(path => readFileSync(path, "utf8"));
    harness.selections.push(tierChoices(undefined, openAIModel).find(item => item.value === "status")!.label);
    await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
    assert.equal(harness.prompts.length, 1);
    assert.ok(harness.notifications.at(-1)?.message.includes("effective: priority"));
    (harness.ctx as ExtensionCommandContext).hasUI = false;
    await harness.commands.get("service-tier-user")?.handler("", harness.ctx);
    assert.equal(harness.prompts.length, 1);
    assert.ok(harness.notifications.at(-1)?.message.includes("effective: priority"));
    assert.deepEqual(Object.values(paths).map(path => readFileSync(path, "utf8")), bytes);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("unknown-auth picker labels stay unverified but selection keeps explicit activation without probing", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home); let probes = 0;
  const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    harness.setAuthMode("unknown"); writeMap(paths.map, pickerFixtureMap());
    const mapBytes = readFileSync(paths.map, "utf8");
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    harness.selections.push(tierChoices(undefined, openAIModel).find(item => item.value === "flex")!.label);
    await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
    assert.ok(harness.selectionRequests[0].options.slice(0, SERVICE_TIERS.length).every(label => label.startsWith("service_tier: ? ")));
    assert.match(harness.prompts[0], /auth: unknown/);
    assert.deepEqual(readConfig(paths.project)?.entries?.[modelKey(openAIModel)!], { active: true, serviceTier: "flex" });
    assert.equal(probes, 0);
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
  } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("unavailable-map picker reports the error but keeps all choices without resetting the map", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    setScopedUnknownModelBehavior(paths, "user", "leave-unknown");
    const broken = "{ private-map-marker: broken";
    writeFileSync(paths.map, broken);
    harness.selections.push(tierChoices(undefined, openAIModel).find(item => item.value === "flex")!.label);
    await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
    assert.match(harness.prompts[0], /Support map unavailable/);
    assert.deepEqual(harness.selectionRequests[0].options, tierChoices(undefined, openAIModel).map(({ label }) => label));
    assert.ok(harness.notifications.some(({ type }) => type === "error"));
    assert.ok(harness.notifications.every(({ message }) => !message.includes("private-map-marker")));
    assert.equal(readFileSync(paths.map, "utf8"), broken);
    assert.deepEqual(readConfig(paths.project)?.entries?.[modelKey(openAIModel)!], { active: true, serviceTier: "flex" });
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("an unrecognized picker result is cancelled rather than parsed into a tier", async () => {
  const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
  const harness = createExtensionHarness(cwd, home);
  try {
    harness.selections.push("priority");
    await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
    assert.equal(existsSync(paths.project), false); assert.equal(existsSync(paths.user), false); assert.equal(existsSync(paths.map), false);
    assert.match(harness.notifications.at(-1)!.message, /cancelled/);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

for (const change of ["model", "api", "auth", "auth-round-trip", "model-round-trip", "off", "settings", "invalid-settings", "project", "shutdown"] as const) {
  test(`pending picker discards its stale choice after ${change} changes`, async () => {
    const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
    const harness = createExtensionHarness(cwd, home);
    const selected = deferred<string | undefined>(); let opened = false; let probes = 0;
    let pending: Promise<void> | void = undefined;
    const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
    try {
      writeConfig(paths.user, { unknownModelBehavior: "auto-probe", entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
      (harness.ctx as ExtensionCommandContext).ui.select = async () => { opened = true; return selected.promise; };
      pending = harness.commands.get("service-tier-project")!.handler("", harness.ctx);
      assert.equal(opened, true);
      if (change === "model") harness.setModel(ultrafastModel);
      if (change === "api") harness.setModel({ ...openAIModel as object, api: "openai-completions" } as never);
      if (change === "auth") harness.setAuthMode("oauth");
      if (change === "auth-round-trip") {
        harness.setAuthMode("oauth"); await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
        harness.setAuthMode("api_key"); await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
      }
      if (change === "model-round-trip") {
        harness.setModel(ultrafastModel); await harness.handlers.get("model_select")?.({} as never, harness.ctx);
        harness.setModel(openAIModel); await harness.handlers.get("model_select")?.({} as never, harness.ctx);
      }
      if (change === "off") await harness.commands.get("service-tier-user")?.handler("off", harness.ctx);
      if (change === "settings") setScopedEntry(paths, "user", modelKey(openAIModel)!, { active: false });
      if (change === "invalid-settings") writeFileSync(paths.user, "{ private-settings-marker: broken");
      if (change === "project") (harness.ctx as ExtensionCommandContext).cwd = join(cwd, "another-project");
      if (change === "shutdown") await harness.handlers.get("session_shutdown")?.({} as never, harness.ctx);
      const bytes = Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined);
      const notices = harness.notifications.length;
      selected.resolve(tierChoices(undefined, openAIModel).find(item => item.value === "flex")!.label);
      await pending; await expectAutoProbesToSettle();
      assert.equal(probes, 0);
      assert.deepEqual(Object.values(paths).map(path => existsSync(path) ? readFileSync(path, "utf8") : undefined), bytes);
      assert.equal(existsSync(configPaths(join(cwd, "another-project"), home).project), false);
      if (change === "shutdown") assert.equal(harness.notifications.length, notices);
      else assert.ok(harness.notifications.some(({ message }) => message.includes("discarded") || message.includes("config")));
      assert.ok(harness.notifications.every(({ message }) => !message.includes("private-settings-marker")));
    } finally {
      selected.resolve(undefined); await pending!; await expectAutoProbesToSettle();
      restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });
}

test("blocked routes and broken whole-config scopes never open the tier picker", async () => {
  for (const blocked of [true, false]) {
    const cwd = tempDir(); const home = tempDir(); const paths = configPaths(cwd, home);
    const harness = createExtensionHarness(cwd, home, blocked ? blockedModels[0] : openAIModel);
    try {
      if (!blocked) { mkdirSync(dirname(paths.user), { recursive: true }); writeFileSync(paths.user, "{ broken"); }
      await harness.commands.get("service-tier-project")?.handler("", harness.ctx);
      assert.equal(harness.prompts.length, 0); assert.equal(existsSync(paths.project), false); assert.equal(existsSync(paths.map), false);
      assert.ok(harness.notifications.some(({ type }) => type === "error"));
    } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }
});

test("can persist map entries", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    writeFixtureMap(paths.map, { entries: { "openai/gpt-5.5": manualEntry(openAIModel) } });
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.determined, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a user-selected tier stays unknown without automatic support seeding", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "leave-unknown");
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    assert.deepEqual(readMap(paths.map)?.entries, {});
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
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
    assert.equal(harness.commands.has("service-tier-refresh-support"), false);
    assert.equal(harness.commands.has("service-tier-refresh-support-all"), false);
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

for (const tier of ["fast", "ultrafast"] as const) {
  test(`${tier} commands persist and inject the selected value without mutating payloads`, async () => {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home, ultrafastModel);
    try {
      const paths = configPaths(cwd, home);
      setScopedUnknownModelBehavior(paths, "user", "leave-unknown");
      await harness.commands.get("service-tier-project")?.handler(tier, harness.ctx);
      assert.equal(readConfig(paths.project)?.entries?.["openai/gpt-6-astra"].serviceTier, tier);
      assert.equal(harness.prompts.length, 0);
      assert.ok(harness.statuses.at(-1)?.value?.includes(`⚡ ${tier}`));
      const original = { model: "gpt-6-astra", service_tier: "default" };
      const payload = await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx);
      assert.deepEqual(payload, { model: "gpt-6-astra", service_tier: tier });
      assert.deepEqual(original, { model: "gpt-6-astra", service_tier: "default" });
      await harness.commands.get("service-tier-project")?.handler("off", harness.ctx);
      assert.equal(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), undefined);
    } finally {
      harness.restore();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("session start does not synthesize support records", async () => {
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

test("session start removes old presets without refreshing errors, user marks or historical probes", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.map), { recursive: true });
    writeFileSync(
      paths.map,
      JSON.stringify({
        version: 1,
        entries: {
          "openai/gpt-5.5": {
            provider: "openai",
            id: "gpt-5.5",
            api: "openai-responses",
            supported: false,
            tiers: [],
            source: "error",
            updatedAt: new Date().toISOString(),
          },
          "opencode-go/qwen3.5-plus": {
            provider: "opencode-go",
            id: "qwen3.5-plus",
            api: "openai-completions",
            determined: true,
            tiers: ["priority", "default"],
            source: "preset",
            updatedAt: new Date().toISOString(),
          },
          "openai-codex/gpt-5.5": {
            provider: "openai-codex",
            id: "gpt-5.5",
            api: "openai-codex-responses",
            determined: true,
            tiers: ["priority", "default"],
            unsupportedTiers: ["flex", "auto", "scale"],
            source: "probe",
            updatedAt: new Date().toISOString(),
          },
          "opencode-go/minimax-m2.5": {
            provider: "opencode-go",
            id: "minimax-m2.5",
            api: "anthropic-messages",
            determined: false,
            tiers: [],
            unsupportedTiers: ["flex"],
            source: "user-mark",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const map = JSON.parse(readFileSync(paths.map, "utf8")) as Required<ServiceTierMapFile>;
    assert.equal(map.entries["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.unknown?.source, "error");
    assert.equal(map.entries["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.unknown?.determined, false);
    assert.deepEqual(map.entries["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.unknown?.tiers, []);
    assert.equal("supported" in (map.entries["openai/gpt-5.5"]?.routes["openai-responses"] ?? {}), false);
    assert.equal(map.entries["opencode-go/qwen3.5-plus"], undefined);
    assert.equal(harness.notifications.filter(({ message }) => message === _test.PRESET_REMOVAL_NOTICE).length, 1);
    assert.equal(map.entries["opencode-go/minimax-m2.5"]?.routes["anthropic-messages"]?.auth.unknown?.source, "user-mark");
    assert.equal(map.entries["opencode-go/minimax-m2.5"]?.routes["anthropic-messages"]?.auth.unknown?.determined, false);
    assert.equal(map.entries["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.unknown?.source, "probe");
    assert.deepEqual(map.entries["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.unknown?.tiers, ["priority", "default"]);
    assert.deepEqual(map.entries["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.unknown?.unsupportedTiers, ["flex", "auto", "scale"]);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("fast command selects priority but does not create support knowledge", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    await harness.commands.get("service-tier-fast-user")?.handler("on", harness.ctx);
    const paths = configPaths(cwd, home);
    assert.deepEqual(readConfig(paths.user)?.entries?.["openai-codex/gpt-5.5"], { active: true, serviceTier: "priority" });
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"], undefined);
    assert.equal(harness.prompts.length, 1);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("tier changes preserve manual knowledge and let users decide unrecorded support", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    const staleEntry = manualEntry(codexModel);
    staleEntry.tiers = ["priority", "default"];
    staleEntry.determined = true;
    writeFixtureMap(paths.map, { entries: { "openai-codex/gpt-5.5": staleEntry } });
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("ultrafast", harness.ctx);
    const map = readMap(paths.map);
    assert.deepEqual(map?.entries?.["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.api_key?.tiers, ["priority", "default"]);
    assert.equal(map?.entries?.["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.api_key?.source, "user-mark");
    assert.equal(mapSupportsTier(map, "openai-codex/gpt-5.5", "priority", codexModel), true);
    assert.equal(harness.prompts.length, 1);
    assert.equal(harness.notifications.some(({ message }) => message.includes("is not supported")), false);
    await harness.commands.get("service-tier-project")?.handler("ultrafast", harness.ctx);
    assert.equal(harness.prompts.length, 1);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("tier commands preserve probe map entries when requested tier is known", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  try {
    const paths = configPaths(cwd, home);
    const key = "openrouter/unverified-model";
    writeFixtureMap(paths.map, markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported", flex: "supported", default: "supported", auto: "supported", scale: "supported", fast: "supported", ultrafast: "supported" }, unknownRouterModel), unknownRouterModel));
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    const entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "probe");
    assert.deepEqual(entry?.tiers, probeCandidates(unknownRouterModel));
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "unverified-model" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "unverified-model", service_tier: "flex" });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("fast commands preserve probe map entries when priority is known", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  try {
    const paths = configPaths(cwd, home);
    const key = "openrouter/unverified-model";
    writeFixtureMap(paths.map, markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported", flex: "unsupported", default: "unsupported", auto: "unsupported", scale: "unsupported", fast: "unsupported", ultrafast: "unsupported" }, unknownRouterModel), unknownRouterModel));
    await harness.commands.get("fast-project")?.handler("on", harness.ctx);
    const entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "probe");
    assert.deepEqual(entry?.tiers, ["priority"]);
    assert.deepEqual(entry?.unsupportedTiers, ["flex", "default", "fast", "ultrafast"]);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("probe-known unsupported tiers do not ask again", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  try {
    const paths = configPaths(cwd, home);
    const key = "openrouter/unverified-model";
    writeFixtureMap(paths.map, markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported", flex: "unsupported", default: "supported", auto: "unsupported", scale: "unsupported", fast: "unsupported", ultrafast: "unsupported" }, unknownRouterModel), unknownRouterModel));
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    const entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "probe");
    assert.deepEqual(entry?.tiers, ["priority", "default"]);
    assert.deepEqual(entry?.unsupportedTiers, ["flex", "fast", "ultrafast"]);
    assert.deepEqual(harness.selections, ["Auto-probe once"]);
    const notices = harness.notifications.filter(({ message }) => message.includes("is not supported"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "warning");
    assert.match(notices[0].message, /configured requests will still send it/);
    assert.deepEqual(readConfig(paths.project)?.entries?.[key], { active: true, serviceTier: "flex" });
    const original = { model: "unverified-model" };
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { ...original, service_tier: "flex" });
    assert.deepEqual(original, { model: "unverified-model" });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("leave unknown choices persist user decisions for unrecorded support", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  try {
    const paths = configPaths(cwd, home);
    const key = "openrouter/unverified-model";
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    let entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "user-mark");
    assert.equal(entry?.determined, false);
    assert.deepEqual(entry?.tiers, []);
    assert.equal(entry?.unsupportedTiers, undefined);

    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "user-mark");
    assert.deepEqual(harness.selections, ["Auto-probe once"]);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("leave unknown and do not ask again writes user-mark and unknown behavior", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  try {
    const paths = configPaths(cwd, home);
    const key = "openrouter/unverified-model";
    harness.selections.push("Always leave unknown");
    await harness.commands.get("service-tier-project")?.handler("scale", harness.ctx);
    const entry = readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "user-mark");
    assert.equal(entry?.determined, false);
    assert.equal(entry?.unsupportedTiers, undefined);
    assert.equal(readConfig(paths.user)?.unknownModelBehavior, "leave-unknown");
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unset support commands only forget user-managed records without recreating them", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  try {
    const paths = configPaths(cwd, home);
    writeFixtureMap(paths.map, putRoute(putRoute({ entries: {} }, manualEntry(codexModel)), manualEntry(openAIModel)));
    await harness.commands.get("service-tier-unset-support")?.handler("", harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"], undefined);
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.source, "manual");
    await harness.commands.get("service-tier-unset-support-all")?.handler("", harness.ctx);
    assert.deepEqual(readMap(paths.map)?.entries, {});
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("unknown behavior command persists to user config", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    await harness.commands.get("service-tier-unknown-behavior")?.handler("auto-probe", harness.ctx);
    assert.equal(readConfig(paths.user)?.unknownModelBehavior, "auto-probe");
    assert.equal(readConfig(paths.project), undefined);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("ask flow runs auto-probe once probe immediately and persists success", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const probedTiers: string[] = [];
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => {
    probedTiers.push(tier);
    return "supported";
  });
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.equal(harness.prompts.length, 1);
    assert.match(harness.prompts[0], /\n\nAuto-probe sends low-token requests/);
    assert.match(harness.prompts[0], /low-token requests/);
    assert.match(harness.prompts[0], /may consume provider tokens/);
    await _test.waitForAutoProbesForTest();
    const entry = readMap(paths.map)?.entries?.["openrouter/unverified-model"]?.routes["openai-completions"]?.auth.api_key;
    assert.deepEqual(probedTiers, probeCandidates(unknownRouterModel));
    assert.equal(entry?.provider, "openrouter");
    assert.equal(entry?.id, "unverified-model");
    assert.equal(entry?.api, "openai-completions");
    assert.equal(entry?.source, "probe");
    assert.equal(entry?.determined, true);
    assert.deepEqual(entry?.tiers, probeCandidates(unknownRouterModel));
    assert.equal(entry?.unsupportedTiers, undefined);
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe started"))?.type, "info");
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe completed"))?.type, "info");
    assert.ok(harness.notifications.every(({ type }) => type === "info"));
    const secondPayload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "unverified-model" } } as never, harness.ctx);
    assert.deepEqual(secondPayload, { model: "unverified-model", service_tier: "flex" });
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("auto-probe does not block configured request injection", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const firstProbe = deferred<"supported">();
  const probedTiers: string[] = [];
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => {
    probedTiers.push(tier);
    if (tier === "priority") await firstProbe.promise;
    return "supported";
  });
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.deepEqual(probedTiers, ["priority"]);
    assert.equal(readMap(paths.map)?.entries?.["openrouter/unverified-model"]?.routes["openai-completions"]?.auth.api_key?.source, undefined);

    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "unverified-model" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "unverified-model", service_tier: "flex" });

    firstProbe.resolve("supported");
    await _test.waitForAutoProbesForTest();
    const entry = readMap(paths.map)?.entries?.["openrouter/unverified-model"]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry?.source, "probe");
    assert.deepEqual(entry?.tiers, probeCandidates(unknownRouterModel));
  } finally {
    firstProbe.resolve("supported");
    await _test.waitForAutoProbesForTest();
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("auto-probe shows and clears probing status", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const restoreProbe = _test.setProbeTierForTest(async () => "supported");
  try {
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await _test.waitForAutoProbesForTest();
    assert.equal(
      harness.statuses.some(({ value }) => value?.includes("service_tier") && value.includes("probing flex")),
      true,
    );
    assert.equal(harness.statuses.at(-1)?.value?.includes("probing flex"), false);
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("user-selected auto-probe behavior probes all candidates even when manual support is recorded", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, codexModel);
  const probedTiers: string[] = [];
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => {
    probedTiers.push(tier);
    return tier === "priority" || tier === "default" ? "supported" : "unsupported";
  });
  try {
    const paths = configPaths(cwd, home);
    writeFixtureMap(paths.map, putRoute({ entries: {} }, manualEntry(codexModel)));
    await harness.commands.get("service-tier-unknown-behavior")?.handler("auto-probe", harness.ctx);
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    await _test.waitForAutoProbesForTest();
    const entry = readMap(paths.map)?.entries?.["openai-codex/gpt-5.5"]?.routes["openai-codex-responses"]?.auth.api_key;
    assert.deepEqual(probedTiers, [...SERVICE_TIERS]);
    assert.equal(entry?.source, "probe");
    assert.deepEqual(entry?.tiers, ["priority", "default"]);
    assert.deepEqual(entry?.unsupportedTiers, ["flex", "auto", "scale", "fast", "ultrafast"]);
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe completed"))?.type, "info", "Other candidates' rejections are normal probe results, not a failure of the selected tier");
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("auto-probe leaves map unchanged when any tier is unknown", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => (tier === "flex" ? "unknown" : "supported"));
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await _test.waitForAutoProbesForTest();
    const entry = readMap(paths.map)?.entries?.["openrouter/unverified-model"]?.routes["openai-completions"]?.auth.api_key;
    assert.equal(entry, undefined);
    const incomplete = harness.notifications.filter(({ message }) => message.includes("did not determine flex"));
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].type, "warning");
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe started"))?.type, "info");
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
    assert.deepEqual(readConfig(paths.project)?.entries?.["openrouter/unverified-model"], { active: true, serviceTier: "flex" });
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("probe execution failures are errors without changing explicit activation or saving results", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const restoreProbe = _test.setProbeTierForTest(async () => { throw new Error("Offline probe failure"); });
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await _test.waitForAutoProbesForTest();
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe started"))?.type, "info");
    const failures = harness.notifications.filter(({ message }) => message.includes("auto-probe failed"));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].type, "error");
    assert.match(failures[0].message, /Offline probe failure/);
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
    assert.equal(readMap(paths.map)?.entries?.["openrouter/unverified-model"], undefined);
    assert.deepEqual(readConfig(paths.project)?.entries?.["openrouter/unverified-model"], { active: true, serviceTier: "flex" });
    const original = { service_tier: "default" };
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), { service_tier: "flex" });
    assert.deepEqual(original, { service_tier: "default" });
  } finally {
    await _test.waitForAutoProbesForTest();
    restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("ask flow always auto-probe probes immediately and keeps auto-probe behavior", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const probedTiers: string[] = [];
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => {
    probedTiers.push(tier);
    return "unsupported";
  });
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Always auto-probe");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await _test.waitForAutoProbesForTest();
    assert.equal(readConfig(paths.user)?.unknownModelBehavior, "auto-probe");
    const entry = readMap(paths.map)?.entries?.["openrouter/unverified-model"]?.routes["openai-completions"]?.auth.api_key;
    assert.deepEqual(probedTiers, probeCandidates(unknownRouterModel));
    assert.equal(entry?.provider, "openrouter");
    assert.equal(entry?.id, "unverified-model");
    assert.equal(entry?.api, "openai-completions");
    assert.equal(entry?.source, "probe");
    assert.equal(entry?.determined, true);
    assert.deepEqual(entry?.tiers, []);
    assert.deepEqual(entry?.unsupportedTiers, probeCandidates(unknownRouterModel));
    assert.equal(entry?.error, `service_tier auto-probe rejected: ${probeCandidates(unknownRouterModel).join(", ")}`);
    assert.equal(harness.notifications.find(({ message }) => message.includes("auto-probe started"))?.type, "info");
    const completed = harness.notifications.filter(({ message }) => message.includes("auto-probe completed"));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].type, "warning");
    assert.match(completed[0].message, /Probed service_tier=flex was rejected; tier settings were not changed/);
    assert.equal(harness.notifications.some(({ type }) => type === "error"), false, "Expected probe rejections are not failed configured requests");
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "flex" });
  } finally {
    restoreProbe();
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
    writeConfig(paths.user, { entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, { entries: {} });
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "priority" });
    await harness.handlers.get("message_end")?.(
      { message: { role: "assistant", errorMessage: "service_tier is not supported by this model" } } as never,
      harness.ctx,
    );
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key?.unsupportedTiers?.includes("priority"), true);
    const failures = harness.notifications.filter(({ message }) => message.includes("service_tier=priority failed"));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].type, "error");
    assert.match(failures[0].message, /The failed request was not retried/);
    assert.deepEqual(readConfig(paths.user)?.entries?.["openai/gpt-5.5"], { active: true, serviceTier: "priority" });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("off requests clear previous injection tracking and cannot mark other payloads unsupported", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, { entries: { [key]: manualEntry(openAIModel) } });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    writeFileSync(paths.user, JSON.stringify({ version: 2, entries: { [key]: { active: true, serviceTier: "fleex" } } }));
    await harness.commands.get("service-tier-user")?.handler("status", harness.ctx);
    const payload = { service_tier: "default" };
    assert.equal(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), undefined);
    assert.deepEqual(payload, { service_tier: "default" });
    const before = readFileSync(paths.map, "utf8");
    await harness.handlers.get("message_end")?.({ message: { role: "assistant", errorMessage: "Invalid service_tier" } } as never, harness.ctx);
    assert.equal(readFileSync(paths.map, "utf8"), before);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("configured request-time injection does not persist support on success", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    writeConfig(paths.user, { entries: { "openai/gpt-5.5": { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, { entries: {} });
    const payload = await harness.handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.5" } } as never, harness.ctx);
    assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "priority" });
    await harness.handlers.get("message_end")?.({ message: { role: "assistant" } } as never, harness.ctx);
    assert.equal(readMap(paths.map)?.entries?.["openai/gpt-5.5"]?.routes["openai-responses"]?.auth.api_key, undefined);
    assert.equal(
      harness.notifications.some(({ message }) => message.includes("auto-probe injection started")),
      false,
    );
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});


test("service-tier eligibility is fail-closed and provider/API-specific", () => {
  for (const [provider, apis] of [
    ["openai", ["openai-responses", "openai-completions"]],
    ["openai-codex", ["openai-codex-responses"]],
    ["openrouter", ["openai-completions", "openai-responses", "anthropic-messages"]],
    ["xai", ["openai-completions", "openai-responses"]],
    ["groq", ["openai-completions"]],
  ] as const) {
    assert.equal(isServiceTierProviderSupported(provider), true);
    for (const api of apis) assert.equal(isServiceTierModelSupported({ provider, api }), true);
    assert.equal(isServiceTierModelSupported({ provider }), false);
    assert.equal(isServiceTierModelSupported({ provider, api: "unknown-api" }), false);
  }
  assert.equal(isServiceTierModelSupported(undefined), false);
  for (const model of blockedModels) assert.equal(isServiceTierModelSupported(model), false);
});

for (const model of blockedModels) {
  const identity = model as { provider: string; id: string; api: string };
  test(`blocks all service-tier interactions for ${identity.provider}/${identity.api}, preserving manual settings`, async () => {
    for (const behavior of UNKNOWN_MODEL_BEHAVIORS) {
      const cwd = tempDir();
      const home = tempDir();
      const harness = createExtensionHarness(cwd, home, model);
      let probes = 0;
      let registryCalls = 0;
      const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
      try {
        const paths = configPaths(cwd, home);
        const key = modelKey(model)!;
        writeConfig(paths.user, { unknownModelBehavior: behavior, entries: { [key]: { active: true, serviceTier: "priority" } } });
        writeConfig(paths.project, { entries: { [key]: { active: true, serviceTier: "ultrafast" } } });
        writeFixtureMap(paths.map, { entries: { [key]: {
          ...manualEntry(model), determined: true, tiers: [...SERVICE_TIERS], source: "probe",
        } } });
        const before = [paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8"));
        await harness.handlers.get("session_start")?.({} as never, harness.ctx);
        for (const command of harness.commands.values()) {
          assert.equal(command.getArgumentCompletions?.(""), command.getArgumentCompletions ? null : undefined);
          for (const arg of ["", "on", "off", "status", "priority", "auto-probe"]) await command.handler(arg, harness.ctx);
        }
        const config = resolveEffectiveConfig(cwd, home);
        assert.equal(configuredTierForModel(config, model), undefined);
        assert.equal(resolveTierForModel(config, readMap(paths.map)!, model), undefined);
        assert.equal(mapSupportsTier(readMap(paths.map), key, "priority", openAIModel), false);
        assert.equal(_test.statusText(config, readMap(paths.map)!, model), undefined);
        const original = { model: identity.id, service_tier: "default" };
        assert.equal(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), undefined);
        assert.deepEqual(original, { model: identity.id, service_tier: "default" });
        await harness.handlers.get("message_end")?.({ message: { role: "assistant", errorMessage: "Invalid service_tier" } } as never, harness.ctx);
        assert.equal(await _test.runAutoProbeForCurrentTier(harness.ctx, key, "priority"), "unknown");
        const probeCtx = { modelRegistry: { ...API_KEY_AUTH, streamSimple: () => { registryCalls++; throw new Error("Must not resolve a blocked provider"); } } } as never;
        assert.equal((await _test.defaultProbeTier(model, "priority", probeCtx)).result, "unknown");
        await _test.waitForAutoProbesForTest();
        assert.equal(probes, 0);
        assert.equal(registryCalls, 0);
        assert.equal(harness.prompts.length, 0);
        assert.ok(harness.statuses.every(({ value }) => value === undefined));
        assert.ok(harness.notifications.every(({ message, type }) => message.includes("blocked") && type === "error"));
        assert.deepEqual([paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8")), before);
      } finally {
        restoreProbe();
        harness.restore();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
}

test("blocked startup and commands do not create config or support-map files", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, blockedModels[0]);
  try {
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    for (const command of harness.commands.values()) await command.handler("on", harness.ctx);
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    const paths = configPaths(cwd, home);
    for (const path of [paths.user, paths.project, paths.map]) assert.equal(existsSync(path), false);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unset-all skips blocked routes and preserves their stored user records", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, openAIModel, [openAIModel, unknownRouterModel, ...blockedModels]);
  try {
    const paths = configPaths(cwd, home);
    const retained = manualEntry(blockedModels[0]);
    writeFixtureMap(paths.map, { entries: { [modelKey(blockedModels[0])!]: retained } });
    const retainedModel = readMap(paths.map)!.entries![modelKey(blockedModels[0])!];
    writeFixtureMap(paths.map, putRoute(putRoute(readMap(paths.map), manualEntry(openAIModel)), manualEntry(unknownRouterModel)));
    await harness.commands.get("service-tier-unset-support-all")?.handler("", harness.ctx);
    assert.deepEqual(readMap(paths.map)?.entries, { [modelKey(blockedModels[0])!]: retainedModel });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("model changes hide blocked UI and restore supported commands and completions", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, blockedModels[0]);
  try {
    const paths = configPaths(cwd, home);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const command = harness.commands.get("service-tier-project")!;
    const editor = harness.autocompleteProviders[0]({
      getSuggestions: async () => null,
      applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    });
    const line = "/service-tier-project u";
    const options = { signal: new AbortController().signal };
    assert.equal(command.getArgumentCompletions?.("u"), null);
    assert.equal(await editor.getSuggestions([line], 0, line.length, options), null);
    harness.setModel(ultrafastModel);
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    assert.deepEqual(command.getArgumentCompletions?.("u"), [{ value: "ultrafast", label: "service_tier: ultrafast" }]);
    assert.deepEqual(await editor.getSuggestions([line], 0, line.length, options), { items: [{ value: "ultrafast", label: "service_tier: ultrafast" }], prefix: "u" });
    await command.handler("ultrafast", harness.ctx);
    assert.equal(readConfig(paths.project)?.entries?.[modelKey(ultrafastModel)!].serviceTier, "ultrafast");
    const before = readFileSync(paths.project, "utf8");
    harness.setModel(blockedModels[0]);
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    assert.equal(command.getArgumentCompletions?.("u"), null);
    assert.equal(await editor.getSuggestions([line], 0, line.length, options), null);
    assert.equal(harness.statuses.at(-1)?.value, undefined);
    await command.handler("priority", harness.ctx);
    assert.equal(readFileSync(paths.project, "utf8"), before);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("auto-probe stops without writing results when the selection changes to a blocked route", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const first = deferred<"supported">();
  const calls: string[] = [];
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier) => { calls.push(tier); return first.promise; });
  try {
    const paths = configPaths(cwd, home);
    harness.selections.push("Auto-probe once");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    const before = readFileSync(paths.map, "utf8");
    harness.setModel(blockedModels[0]);
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    first.resolve("supported");
    await _test.waitForAutoProbesForTest();
    assert.deepEqual(calls, ["priority"]);
    assert.equal(readFileSync(paths.map, "utf8"), before);
    assert.equal(harness.statuses.at(-1)?.value, undefined);
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
  } finally {
    first.resolve("supported");
    await _test.waitForAutoProbesForTest();
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("probe payload hooks abort a resolved blocked route before a provider request", async () => {
  let signal: AbortSignal | undefined;
  const ctx = { modelRegistry: { ...API_KEY_AUTH, streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
    signal = options.signal;
    return (async function* () {
      await options.onPayload?.({}, blockedModels[0]);
      assert.fail("A blocked route must not proceed to its SDK request");
      yield { type: "done" };
    })();
  } } } as never;
  assert.equal((await _test.defaultProbeTier(openAIModel, "priority", ctx)).result, "unknown");
  assert.equal(signal?.aborted, true);
});

test("an outstanding support prompt cannot start a probe or change global behavior after a blocked model is selected", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  let probes = 0;
  const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    const ctx = harness.ctx as ExtensionContext;
    ctx.ui.select = async () => {
      harness.setModel(blockedModels[0]);
      await harness.handlers.get("model_select")?.({} as never, harness.ctx);
      return "Always auto-probe";
    };
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await _test.waitForAutoProbesForTest();
    assert.equal(probes, 0);
    assert.equal(readConfig(configPaths(cwd, home).user), undefined);
    assert.equal(readMap(configPaths(cwd, home).map)?.entries?.[modelKey(unknownRouterModel)!]?.routes["openai-completions"]?.auth.api_key?.source, undefined);
    assert.equal(harness.statuses.at(-1)?.value, undefined);
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("config migration and unrelated writes do not synthesize tiers or reactivate invalid overrides", () => {
  const cwd = tempDir();
  const home = tempDir();
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    const retainedKey = modelKey(ultrafastModel)!;
    const retained = { active: true, serviceTier: "ultrafast" as const };
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "flex" }, [retainedKey]: retained } });
    mkdirSync(dirname(paths.project), { recursive: true });
    for (const version of [1, 2]) {
      writeFileSync(paths.project, JSON.stringify({ version, entries: { [key]: { active: true, serviceTier: "fleex" } } }));
      assert.equal(configuredTierForModel(resolveEffectiveConfig(cwd, home), openAIModel), undefined);
      _test.migrateStartupFiles(paths);
      assert.deepEqual(JSON.parse(readFileSync(paths.project, "utf8")).entries[key], { active: false });
      setScopedUnknownModelBehavior(paths, "project", "auto-probe");
      const config = resolveEffectiveConfig(cwd, home);
      assert.equal(configuredTierForModel(config, openAIModel), undefined);
      assert.deepEqual(config.entries[retainedKey], retained);
    }
    writeFileSync(paths.project, JSON.stringify({ version: 1, entries: { [retainedKey]: { active: true } } }));
    _test.migrateStartupFiles(paths);
    assert.deepEqual(JSON.parse(readFileSync(paths.project, "utf8")).entries[retainedKey], { active: true });
    const withoutUser = mergeConfigs(undefined, readConfig(paths.project), paths);
    assert.deepEqual(withoutUser.entries[retainedKey], { active: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing and invalid manual tiers stay off through startup, status, hooks, and support maintenance", async () => {
  const key = modelKey(openAIModel)!;
  const cases = [
    { scope: "user", entry: { active: true } },
    { scope: "project", entry: { active: true } },
    ...["fleex", "off", "standard_only", "", null, 0, true, [], {}].flatMap((serviceTier) => [
      { scope: "user", entry: { active: true, serviceTier } },
      { scope: "project", entry: { active: true, serviceTier }, validUser: true },
    ]),
  ];
  for (const scenario of cases) {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home);
    let probes = 0;
    const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
    try {
      const paths = configPaths(cwd, home);
      const validUser = "validUser" in scenario && scenario.validUser;
      const userEntry = scenario.scope === "user" ? scenario.entry : validUser ? { active: true, serviceTier: "flex" } : undefined;
      const rawUser = { version: 2, unknownModelBehavior: "auto-probe", entries: userEntry ? { [key]: userEntry } : {} };
      mkdirSync(dirname(paths.user), { recursive: true });
      writeFileSync(paths.user, JSON.stringify(rawUser));
      if (scenario.scope === "project") {
        mkdirSync(dirname(paths.project), { recursive: true });
        writeFileSync(paths.project, JSON.stringify({ version: 2, entries: { [key]: scenario.entry } }));
      }
      writeFixtureMap(paths.map, { entries: { [key]: manualEntry(openAIModel) } });
      await harness.handlers.get("session_start")?.({} as never, harness.ctx);
      const config = resolveEffectiveConfig(cwd, home);
      assert.equal(config.entries[key].active, false);
      assert.equal(configuredTierForModel(config, openAIModel), undefined);
      for (const payload of [{ model: "gpt-5.5" }, { model: "gpt-5.5", service_tier: "default" }]) {
        const original = { ...payload };
        assert.equal(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), undefined);
        assert.deepEqual(payload, original);
      }
      for (const command of ["service-tier-project", "service-tier-user", "fast-project", "fast-user"]) {
        await harness.commands.get(command)?.handler("status", harness.ctx);
      }
      await _test.waitForAutoProbesForTest();
      assert.equal(probes, 0);
      assert.equal(harness.prompts.length, 0);
      assert.ok(harness.statuses.every(({ value }) => value === "service_tier: ○ off"));
      const statuses = harness.notifications.filter(({ message }) => message.includes("effective:"));
      assert.equal(statuses.length, 4);
      assert.ok(statuses.every(({ message }) => message.includes("effective: off")));
    } finally {
      restoreProbe();
      harness.restore();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("fast commands explicitly select priority and recover from invalid or missing tiers", async () => {
  const key = modelKey(openAIModel)!;
  for (const command of ["service-tier-fast-project", "service-tier-fast-user", "fast-project", "fast-user"]) {
    for (const entry of [{ active: true }, { active: true, serviceTier: "fleex" }]) {
      const cwd = tempDir();
      const home = tempDir();
      const harness = createExtensionHarness(cwd, home);
      try {
        const paths = configPaths(cwd, home);
        const path = command.endsWith("project") ? paths.project : paths.user;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 2, unknownModelBehavior: "leave-unknown", entries: { [key]: entry } }));
        await harness.handlers.get("session_start")?.({} as never, harness.ctx);
        await harness.commands.get(command)?.handler("", harness.ctx);
        assert.deepEqual(readConfig(path)?.entries?.[key], { active: true, serviceTier: "priority" });
        const payload = { model: "gpt-5.5" };
        assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), { ...payload, service_tier: "priority" });
        assert.deepEqual(payload, { model: "gpt-5.5" });
      } finally {
        harness.restore();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test("explicit tier commands repair invalid overrides without dropping unrelated entries", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    const retainedKey = modelKey(ultrafastModel)!;
    const retained = { active: true, serviceTier: "ultrafast" as const };
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "priority" } } });
    mkdirSync(dirname(paths.project), { recursive: true });
    writeFileSync(paths.project, JSON.stringify({ version: 2, entries: { [key]: { active: true, serviceTier: "fleex" }, [retainedKey]: retained } }));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    assert.deepEqual(readConfig(paths.project)?.entries, { [key]: { active: true, serviceTier: "flex" }, [retainedKey]: retained });
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "flex" });
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("whole-scope JSON/schema errors are distinct from missing files and cannot fall back or be overwritten", () => {
  const cwd = tempDir();
  const home = tempDir();
  const paths = configPaths(cwd, home);
  const key = modelKey(openAIModel)!;
  const valid: ConfigFile = { version: 1, entries: { [key]: { active: true, serviceTier: "priority" } } };
  const invalidContents = [
    '{ "private-marker": "do-not-log", broken json',
    ...[null, [], true, 7, "text", { entries: [] }, { entries: null }, { entries: "bad" },
      { version: 3, entries: {} }, { version: "2", entries: {} }, { version: 0 },
      { unknownModelBehavior: "turbo", entries: {} }].map((value) => JSON.stringify(value)),
  ];
  try {
    assert.equal(readConfig(paths.user), undefined);
    writeConfig(paths.user, valid);
    assert.equal(configuredTierForModel(resolveEffectiveConfig(cwd, home), openAIModel), "priority");
    ensureConfig(paths.project);
    assert.equal(configuredTierForModel(resolveEffectiveConfig(cwd, home), openAIModel), "priority");

    for (const scope of ["project", "user"] as const) {
      const other = scope === "project" ? "user" : "project";
      for (const contents of invalidContents) {
        writeFileSync(paths[other], JSON.stringify(valid));
        writeFileSync(paths[scope], contents);
        const beforeOther = readFileSync(paths[other], "utf8");
        assert.throws(() => readConfig(paths[scope]), (error: unknown) =>
          error instanceof ConfigFileError && !error.message.includes("do-not-log"));
        const effective = resolveEffectiveConfig(cwd, home);
        assert.equal(effective.configIssues?.length, 1);
        assert.equal(effective.configIssues?.[0].path, paths[scope]);
        assert.equal(configuredTierForModel(effective, openAIModel), undefined);
        assert.equal(_test.statusText(effective, {}, openAIModel), "service_tier ○ off (config error)");
        for (const action of [
          () => ensureConfig(paths[scope]),
          () => writeConfig(paths[scope], valid),
          () => setScopedEntry(paths, scope, key, { active: false }),
          () => setScopedEntry(paths, other, key, { active: true, serviceTier: "flex" }),
          () => setScopedUnknownModelBehavior(paths, other, "auto-probe"),
          () => _test.migrateStartupFiles(paths),
        ]) assert.throws(action, ConfigFileError);
        assert.equal(readFileSync(paths[scope], "utf8"), contents);
        assert.equal(readFileSync(paths[other], "utf8"), beforeOther);
        assert.equal(existsSync(paths.map), false);
      }
    }
    const direct = mergeConfigs(valid as ConfigFile, { entries: [] } as never, paths);
    assert.equal(configuredTierForModel(direct, openAIModel), undefined);
    assert.equal(direct.configIssues?.[0].reason, "schema");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unreadable configs and dangling symlinks are errors, not opportunities to create defaults", () => {
  const cwd = tempDir();
  const home = tempDir();
  const paths = configPaths(cwd, home);
  const missingTarget = join(cwd, "missing-config-target.json");
  try {
    writeConfig(paths.user, { entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    mkdirSync(paths.project, { recursive: true });
    assert.throws(() => ensureConfig(paths.project), (error: unknown) => error instanceof ConfigFileError && error.issue.reason === "read");
    assert.equal(configuredTierForModel(resolveEffectiveConfig(cwd, home), openAIModel), undefined);
    rmSync(paths.project, { recursive: true });
    symlinkSync(missingTarget, paths.project);
    assert.throws(() => ensureConfig(paths.project), ConfigFileError);
    assert.throws(() => writeConfig(paths.project, {}), ConfigFileError);
    assert.equal(resolveEffectiveConfig(cwd, home).configIssues?.[0].reason, "read");
    assert.equal(readlinkSync(paths.project), missingTarget);
    assert.equal(existsSync(missingTarget), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("config errors suspend lifecycle, commands, request injection and support writes without changing originals", async () => {
  for (const scope of ["project", "user"] as const) {
    for (const contents of ["{ bad json", JSON.stringify({ version: 2, entries: [] })]) {
      const cwd = tempDir();
      const home = tempDir();
      const harness = createExtensionHarness(cwd, home);
      const paths = configPaths(cwd, home);
      let probes = 0;
      let availableCalls = 0;
      const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
      try {
        for (const path of [paths.user, paths.project]) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify({ version: 1, unknownModelBehavior: "auto-probe", entries: {
            [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" },
          } }));
        }
        writeFileSync(paths[scope], contents);
        writeFixtureMap(paths.map, { entries: { [modelKey(openAIModel)!]: { ...manualEntry(openAIModel), source: "probe" } } });
        const before = [paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8"));
        (harness.ctx as ExtensionContext).modelRegistry.getAvailable = () => { availableCalls++; return []; };
        await harness.handlers.get("session_start")?.({} as never, harness.ctx);
        await harness.handlers.get("model_select")?.({} as never, harness.ctx);
        for (const command of harness.commands.values()) {
          for (const arg of ["status", "off", "priority", "auto-probe"]) await command.handler(arg, harness.ctx);
        }
        const original = { model: "gpt-5.5", service_tier: "default" };
        assert.equal(await harness.handlers.get("before_provider_request")?.({ payload: original } as never, harness.ctx), undefined);
        assert.deepEqual(original, { model: "gpt-5.5", service_tier: "default" });
        await harness.handlers.get("message_end")?.({ message: { role: "assistant", errorMessage: "Invalid service_tier" } } as never, harness.ctx);
        await _test.waitForAutoProbesForTest();
        assert.equal(probes, 0);
        assert.equal(availableCalls, 0);
        assert.equal(harness.prompts.length, 0);
        assert.equal(harness.notifications.filter(({ type }) => type === "error").length, 1);
        assert.ok(harness.notifications.some(({ message }) => message.includes(paths[scope])));
        assert.equal(harness.statuses.at(-1)?.value, "service_tier ○ off (config error)");
        assert.deepEqual([paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8")), before);
      } finally {
        restoreProbe();
        harness.restore();
        rmSync(cwd, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
});

test("config errors introduced after injection invalidate cached tiers and preserve support evidence until external repair", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  const paths = configPaths(cwd, home);
  const key = modelKey(openAIModel)!;
  try {
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "priority" } } });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const payload = { model: "gpt-5.5" };
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), { ...payload, service_tier: "priority" });
    mkdirSync(dirname(paths.project), { recursive: true });
    writeFileSync(paths.project, "{ broken");
    const beforeMap = readFileSync(paths.map, "utf8");
    // No status command or reload occurs between the edit and the request/error.
    await harness.handlers.get("message_end")?.({ message: { role: "assistant", errorMessage: "Invalid service_tier" } } as never, harness.ctx);
    assert.equal(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), undefined);
    assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
    assert.equal(readFileSync(paths.project, "utf8"), "{ broken");
    writeFileSync(paths.project, JSON.stringify({ version: 2, entries: { [key]: { active: true, serviceTier: "flex" } } }));
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), { ...payload, service_tier: "flex" });
    assert.ok(harness.statuses.at(-1)?.value?.includes("flex"));
    assert.equal(harness.statuses.at(-1)?.value?.includes("off"), false);
    writeFileSync(paths.project, JSON.stringify({ entries: { [key]: { active: false } } }));
    assert.equal(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), undefined);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
    writeFileSync(paths.project, JSON.stringify({ entries: { [key]: { active: true, serviceTier: "ultrafast" } } }));
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), { ...payload, service_tier: "ultrafast" });
    assert.ok(harness.statuses.at(-1)?.value?.includes("ultrafast"));
    assert.deepEqual(payload, { model: "gpt-5.5" });
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

async function expectAutoProbesToSettle(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      _test.waitForAutoProbesForTest(),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Cancelled probes did not settle")), 1500); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("off reaches the real probe implementation's SDK signal and blocks late payload hooks", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  const entered = deferred<void>();
  const release = deferred<void>();
  let sdkSignal: AbortSignal | undefined;
  let payloadHook: SimpleStreamOptions["onPayload"];
  let streams = 0;
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    (harness.ctx as ExtensionContext).modelRegistry.streamSimple = (model, _context, options = {}) => {
      streams++;
      sdkSignal = options.signal;
      payloadHook = options.onPayload;
      return (async function* () {
        assert.deepEqual(await payloadHook?.({}, model), { service_tier: "priority" });
        entered.resolve();
        await release.promise;
        yield { type: "done" };
      })() as never;
    };
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    await entered.promise;
    const beforeMap = readFileSync(paths.map, "utf8");
    await harness.commands.get("service-tier-project")?.handler("off", harness.ctx);
    assert.equal(sdkSignal?.aborted, true);
    await expectAutoProbesToSettle();
    await assert.rejects(async () => payloadHook?.({}, openAIModel), /probe cancelled/);
    assert.equal(streams, 1);
    assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
    release.resolve();
    await Promise.resolve();
    assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
  } finally {
    release.resolve();
    await _test.waitForAutoProbesForTest();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("default probes forward cancellation to the registry signal and close non-cooperative streams promptly", async () => {
  const parent = new AbortController();
  const next = deferred<never>();
  let registrySignal: AbortSignal | undefined;
  let closed = false;
  const ctx = { modelRegistry: { ...API_KEY_AUTH, streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
    registrySignal = options.signal;
    return { [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: async () => { closed = true; return { done: true }; } }) };
  } } } as never;
  const probe = _test.defaultProbeTier(openAIModel, "priority", ctx, parent.signal);
  try {
    assert.equal(registrySignal?.aborted, false);
    parent.abort();
    assert.equal(registrySignal?.aborted, true);
    assert.equal((await probe).result, "unknown");
    assert.equal(closed, true);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    assert.equal(getEventListeners(registrySignal!, "abort").length, 0);
  } finally {
    parent.abort();
    next.resolve({ done: true } as never);
    await probe;
  }
  const aborted = new AbortController();
  aborted.abort();
  const noCalls = { modelRegistry: { ...API_KEY_AUTH, streamSimple: () => assert.fail("Already cancelled probes must not open a stream") } } as never;
  assert.equal((await _test.defaultProbeTier(openAIModel, "priority", noCalls, aborted.signal)).result, "unknown");
});

test("all tier/fast off commands and fast-off toggles cancel pending probes without waiting for or saving late results", async () => {
  const cases = [
    ...["service-tier-project", "service-tier-user", "service-tier-fast-project", "service-tier-fast-user", "fast-project", "fast-user"]
      .map((command) => ({ command, arg: "off" })),
    { command: "fast-project", arg: "" },
    { command: "service-tier-fast-user", arg: "" },
  ];
  for (const { command, arg } of cases) {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home, unknownRouterModel);
    const first = deferred<"supported">();
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const restoreProbe = _test.setProbeTierForTest(async (_model, tier, _ctx, currentSignal) => {
      calls.push(tier); signal = currentSignal; return first.promise;
    });
    try {
      const paths = configPaths(cwd, home);
      const scope = command.endsWith("project") ? "project" : "user";
      setScopedUnknownModelBehavior(paths, "user", "auto-probe");
      await harness.commands.get(`service-tier-${scope}`)?.handler("priority", harness.ctx);
      assert.deepEqual(calls, ["priority"]);
      const beforeMap = readFileSync(paths.map, "utf8");
      await harness.commands.get(command)?.handler(arg, harness.ctx);
      assert.equal(signal?.aborted, true, command);
      await expectAutoProbesToSettle();
      assert.deepEqual(calls, ["priority"]);
      assert.equal(getEventListeners(signal!, "abort").length, 0);
      assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
      assert.equal(harness.statuses.at(-1)?.value, "service_tier: ○ off");
      assert.equal(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), undefined);
      first.resolve("supported");
      await Promise.resolve();
      assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
      assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
    } finally {
      first.resolve("supported");
      await _test.waitForAutoProbesForTest();
      restoreProbe();
      harness.restore();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("off then on creates a new probe without allowing the cancelled cycle to resume or replace its status", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const first = deferred<"supported">();
  const second = deferred<"unsupported">();
  const signals: Array<AbortSignal | undefined> = [];
  let cycle = 0;
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier, _ctx, signal) => {
    if (tier === "priority") { cycle++; signals.push(signal); }
    return cycle === 1 ? first.promise : second.promise;
  });
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await harness.commands.get("service-tier-project")?.handler("off", harness.ctx);
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    const before = readFileSync(paths.map, "utf8");
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
    first.resolve("supported");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(readFileSync(paths.map, "utf8"), before);
    assert.ok(harness.statuses.at(-1)?.value?.includes("probing"));
    second.resolve("unsupported");
    await expectAutoProbesToSettle();
    assert.equal(cycle, 2);
    assert.deepEqual(readMap(paths.map)?.entries?.[modelKey(unknownRouterModel)!]?.routes["openai-completions"]?.auth.api_key?.tiers, []);
    assert.deepEqual(readMap(paths.map)?.entries?.[modelKey(unknownRouterModel)!]?.routes["openai-completions"]?.auth.api_key?.unsupportedTiers, probeCandidates(unknownRouterModel));
    assert.equal(harness.notifications.filter(({ message }) => message.includes("auto-probe completed")).length, 1);
  } finally {
    first.resolve("supported");
    second.resolve("unsupported");
    await _test.waitForAutoProbesForTest();
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("debug off does not disable a configured tier or cancel its probe", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const first = deferred<"supported">();
  let signal: AbortSignal | undefined;
  const restoreProbe = _test.setProbeTierForTest(async (_model, _tier, _ctx, currentSignal) => { signal = currentSignal; return first.promise; });
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await harness.commands.get("service-tier-debug")?.handler("off", harness.ctx);
    assert.equal(signal?.aborted, false);
    assert.equal(configuredTierForModel(resolveEffectiveConfig(cwd, home), unknownRouterModel), "flex");
    first.resolve("supported");
    await expectAutoProbesToSettle();
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), true);
  } finally {
    first.resolve("supported");
    await _test.waitForAutoProbesForTest();
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("manual off and whole-config errors abort a pending probe via its guard without a command or reload", async () => {
  for (const invalid of [false, true]) {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home, unknownRouterModel);
    const first = deferred<"supported">();
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const restoreProbe = _test.setProbeTierForTest(async (_model, tier, _ctx, currentSignal) => {
      calls.push(tier); signal = currentSignal; return first.promise;
    });
    try {
      const paths = configPaths(cwd, home);
      setScopedUnknownModelBehavior(paths, "user", "auto-probe");
      await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
      const beforeMap = readFileSync(paths.map, "utf8");
      if (invalid) writeFileSync(paths.project, "{ broken");
      else setScopedEntry(paths, "project", modelKey(unknownRouterModel)!, { active: false });
      await expectAutoProbesToSettle();
      assert.equal(signal?.aborted, true);
      assert.deepEqual(calls, ["priority"]);
      assert.equal(readFileSync(paths.map, "utf8"), beforeMap);
      assert.equal(harness.statuses.at(-1)?.value, invalid ? "service_tier ○ off (config error)" : "service_tier: ○ off");
      if (invalid) assert.equal(readFileSync(paths.project, "utf8"), "{ broken");
    } finally {
      first.resolve("supported");
      await _test.waitForAutoProbesForTest();
      restoreProbe();
      harness.restore();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("off prevents the next probe even when the current mock returns supported immediately", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  const paths = configPaths(cwd, home);
  const key = modelKey(unknownRouterModel)!;
  const calls: string[] = [];
  let signal: AbortSignal | undefined;
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier, _ctx, currentSignal) => {
    calls.push(tier); signal = currentSignal;
    setScopedEntry(paths, "project", key, { active: false });
    return "supported";
  });
  try {
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
    await expectAutoProbesToSettle();
    assert.deepEqual(calls, ["priority"]);
    assert.equal(signal?.aborted, true);
    assert.equal(readMap(paths.map)?.entries?.[key]?.routes["openai-completions"]?.auth.api_key?.source, undefined);
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
  } finally {
    restoreProbe();
    harness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("an off command invalidates outstanding probe prompts even if the tier is later reactivated", async () => {
  for (const reactivate of [false, true]) {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home, unknownRouterModel);
    const prompt = deferred<void>();
    const choice = deferred<string>();
    let probes = 0;
    const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
    let enable: Promise<void> | void = undefined;
    try {
      const ctx = harness.ctx as ExtensionContext;
      ctx.ui.select = async () => { prompt.resolve(); return choice.promise; };
      enable = harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
      await prompt.promise;
      await harness.commands.get("fast-project")?.handler("off", harness.ctx);
      const paths = configPaths(cwd, home);
      if (reactivate) setScopedEntry(paths, "project", modelKey(unknownRouterModel)!, { active: true, serviceTier: "flex" });
      const before = readFileSync(paths.map, "utf8");
      choice.resolve("Always auto-probe");
      await enable;
      await expectAutoProbesToSettle();
      assert.equal(probes, 0);
      assert.equal(readConfig(paths.user)?.unknownModelBehavior, undefined);
      assert.equal(readFileSync(paths.map, "utf8"), before);
    } finally {
      choice.resolve("Always auto-probe");
      await enable;
      await _test.waitForAutoProbesForTest();
      restoreProbe();
      harness.restore();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("shutdown cancels only its extension instance and cannot restore stale status or save late probe results", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const firstHarness = createExtensionHarness(cwd, home, unknownRouterModel);
  const secondHarness = createExtensionHarness(cwd, home, unknownRouterModel);
  const first = deferred<"supported">();
  const second = deferred<"supported">();
  const calls = new Map<unknown, string[]>();
  const signals = new Map<unknown, AbortSignal | undefined>();
  const restoreProbe = _test.setProbeTierForTest(async (_model, tier, ctx, signal) => {
    calls.set(ctx, [...calls.get(ctx) ?? [], tier]);
    signals.set(ctx, signal);
    return ctx === firstHarness.ctx ? first.promise : second.promise;
  });
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await firstHarness.commands.get("service-tier-project")?.handler("flex", firstHarness.ctx);
    await secondHarness.commands.get("service-tier-project")?.handler("flex", secondHarness.ctx);
    await firstHarness.handlers.get("session_shutdown")?.({} as never, firstHarness.ctx);
    assert.equal(signals.get(firstHarness.ctx)?.aborted, true);
    assert.equal(signals.get(secondHarness.ctx)?.aborted, false);
    first.resolve("supported");
    second.resolve("supported");
    await expectAutoProbesToSettle();
    assert.deepEqual(calls.get(firstHarness.ctx), ["priority"]);
    assert.deepEqual(calls.get(secondHarness.ctx), probeCandidates(unknownRouterModel));
    assert.equal(firstHarness.statuses.at(-1)?.value, undefined);
    assert.equal(await firstHarness.handlers.get("before_provider_request")?.({ payload: {} } as never, firstHarness.ctx), undefined);
    assert.equal(firstHarness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
    assert.equal(secondHarness.notifications.some(({ message }) => message.includes("auto-probe completed")), true);
  } finally {
    first.resolve("supported");
    second.resolve("supported");
    await _test.waitForAutoProbesForTest();
    restoreProbe();
    secondHarness.restore();
    firstHarness.restore();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("same-key API switches do not reuse support or user marks, and commands preserve the other API slot", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  const alternate = { ...openAIModel as object, provider: "openai", id: "gpt-5.5", api: "openai-completions" } as never;
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    writeConfig(paths.user, { statusFormat: STATUS_FORMAT_PRESETS.long, entries: { [key]: { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, putRoute({ entries: {} }, manualEntry(openAIModel)));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const original = readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key;
    harness.setModel(alternate);
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | unknown");
    assert.equal(mapSupportsTier(readMap(paths.map), key, "priority", alternate), false);
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    assert.equal(harness.prompts.length, 1);
    assert.equal(readMap(paths.map)!.entries![key].routes["openai-completions"]?.auth.api_key?.source, "user-mark");
    assert.deepEqual(readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key, original);
    assert.deepEqual(readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key, original);
    await harness.commands.get("service-tier-unset-support")?.handler("", harness.ctx);
    assert.equal(readMap(paths.map)!.entries![key].routes["openai-completions"]?.auth.api_key, undefined);
    assert.deepEqual(readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key, original);
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("request errors from a previous API cannot mark the current same-key route rejected", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, putRoute({ entries: {} }, manualEntry(openAIModel)));
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    const before = readFileSync(paths.map, "utf8");
    harness.setModel({ ...openAIModel as object, provider: "openai", id: "gpt-5.5", api: "openai-completions" } as never);
    await harness.handlers.get("message_end")?.({ message: { role: "assistant", provider: "openai", model: "gpt-5.5", api: "openai-responses", errorMessage: "Invalid service_tier" } } as never, harness.ctx);
    assert.equal(readFileSync(paths.map, "utf8"), before);
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("a malformed support map preserves bytes without disabling healthy explicit tier settings", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    writeConfig(paths.user, { statusFormat: STATUS_FORMAT_PRESETS.long, entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    mkdirSync(dirname(paths.map), { recursive: true });
    const broken = "{ private-map-content: broken";
    writeFileSync(paths.map, broken);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | unknown");
    await harness.commands.get("service-tier-unset-support")?.handler("", harness.ctx);
    assert.equal(readFileSync(paths.map, "utf8"), broken);
    assert.ok(harness.notifications.every(({ message }) => !message.includes("private-map-content")));
    assert.equal(harness.prompts.length, 0);
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    writeFileSync(paths.map, JSON.stringify(putRoute({ entries: {} }, manualEntry(openAIModel))));
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | manual");
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("normal upgrade tolerates partial map records and leaves healthy v2 config bytes untouched", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    mkdirSync(dirname(paths.user), { recursive: true });
    const userBytes = JSON.stringify({ version: 2, extra: "keep", entries: { [key]: { active: true, serviceTier: "priority" } } }, null, 4);
    writeFileSync(paths.user, userBytes);
    const original = JSON.stringify({ version: "2", entries: { [key]: { ...manualEntry(openAIModel), source: { toString: "not-a-function" }, updatedAt: 12 }, "openai/no-api": { tiers: ["priority"] }, bad: null } });
    writeFileSync(paths.map, original);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(JSON.parse(readFileSync(paths.map, "utf8")).version, 3);
    assert.equal(readFileSync(paths.user, "utf8"), userBytes);
    assert.deepEqual(readMap(paths.map)?.entries?.["openai/no-api"].legacy, [{ tiers: ["priority"] }]);
    assert.equal(harness.notifications.some(({ type }) => type === "error"), false);
    assert.equal(harness.prompts.length, 0);
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("missing probe payload hooks stop after one completed request without saving false support", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home, unknownRouterModel);
  let streams = 0;
  const registry = (harness.ctx as { modelRegistry: { streamSimple?: unknown } }).modelRegistry;
  registry.streamSimple = (_model: unknown, _context: unknown, options: SimpleStreamOptions) => (async function* () {
    streams++;
    await options.onProviderStreamEvent?.({ choices: [], service_tier: "priority" }, unknownRouterModel);
    yield { type: "done" };
  })();
  try {
    const paths = configPaths(cwd, home);
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    const before = readFileSync(paths.map, "utf8");
    await _test.waitForAutoProbesForTest();
    assert.equal(streams, 1);
    assert.equal(readFileSync(paths.map, "utf8"), before);
    assert.equal(mapSupportsTier(readMap(paths.map), modelKey(unknownRouterModel), "priority", unknownRouterModel), false);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
  } finally {
    await _test.waitForAutoProbesForTest(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("real probe instrumentation saves completion/fallback separately without fabricating requested-tier support", async () => {
  for (const servedTier of [undefined, "default"] as const) {
    const cwd = tempDir();
    const home = tempDir();
    const harness = createExtensionHarness(cwd, home, unknownRouterModel);
    let streams = 0;
    const registry = (harness.ctx as { modelRegistry: { streamSimple?: unknown } }).modelRegistry;
    registry.streamSimple = (_model: unknown, _context: unknown, options: SimpleStreamOptions) => (async function* () {
      streams++;
      await options.onPayload?.({}, unknownRouterModel);
      if (servedTier) await options.onProviderStreamEvent?.({ choices: [], service_tier: servedTier }, unknownRouterModel);
      yield { type: "done" };
    })();
    try {
      const paths = configPaths(cwd, home);
      setScopedStatusFormat(paths, "user", STATUS_FORMAT_PRESETS.long);
      setScopedUnknownModelBehavior(paths, "user", "auto-probe");
      await harness.commands.get("service-tier-project")?.handler("flex", harness.ctx);
      await _test.waitForAutoProbesForTest();
      const entry = readMap(paths.map)!.entries![modelKey(unknownRouterModel)!].routes["openai-completions"]?.auth.api_key;
      assert.ok(entry);
      assert.equal(streams, probeCandidates(unknownRouterModel).length);
      assert.equal(entry.observations?.flex?.kind, servedTier ? "fallback" : "request-completed");
      assert.equal(mapSupportsTier(readMap(paths.map), modelKey(unknownRouterModel), "flex", unknownRouterModel), false);
      assert.deepEqual(entry.tiers, servedTier ? ["default"] : []);
      assert.equal(harness.statuses.at(-1)?.value, servedTier ? "service_tier: ● flex | fallback → default" : "service_tier: ● flex | probe-completed (tier unknown)");
      assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "flex" });
    } finally {
      await _test.waitForAutoProbesForTest(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  }
});

test("new tier commands and startup do not erase another tier's verified or rejected evidence", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    const verifiedMap = markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported", flex: "unsupported" }), openAIModel);
    writeFixtureMap(paths.map, verifiedMap);
    harness.selections.push("Leave unknown once");
    await harness.commands.get("service-tier-project")?.handler("ultrafast", harness.ctx);
    let route = readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key;
    assert.ok(route);
    assert.equal(route.evidence?.priority?.kind, "verified");
    assert.equal(route.evidence?.flex?.kind, "rejected");
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    route = readMap(paths.map)!.entries![key].routes["openai-responses"]?.auth.api_key;
    assert.ok(route);
    assert.equal(route.evidence?.priority?.kind, "verified");
    assert.equal(route.evidence?.flex?.kind, "rejected");
  } finally {
    harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("startup retires user/project/map presets once, explains the extension origin and keeps explicit settings", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  let probes = 0;
  const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    const paths = configPaths(cwd, home);
    const key = modelKey(openAIModel)!;
    for (const path of [paths.user, paths.project]) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(paths.user, JSON.stringify({ version: 2, note: "keep user", unknownModelBehavior: "auto-probe", presets: {}, entries: {
      [key]: { active: true, serviceTier: "priority", source: "preset", tiers: ["priority"], presetVersion: 2, custom: "keep" },
    } }));
    writeFileSync(paths.project, JSON.stringify({ version: 2, note: "keep project", presetSupport: {}, entries: {
      [key]: { active: true, presetTiers: ["priority"] },
    } }));
    writeFileSync(paths.map, JSON.stringify({ version: 3, entries: { [key]: { routes: {
      "openai-responses": { ...manualEntry(openAIModel), source: "preset" },
      "openai-completions": { ...manualEntry(openAIModel), api: "openai-completions" },
    } } } }));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const notices = harness.notifications.filter(({ message }) => message === _test.PRESET_REMOVAL_NOTICE);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "info");
    assert.match(notices[0].message, /providers, OAuth\/API-key authentication, and API routes/);
    assert.match(notices[0].message, /manually.*Auto Probe/);
    assert.match(notices[0].message, /same provider\/model.*OAuth versus API-key.*APIs/);
    assert.match(notices[0].message, /re-check/);
    const user = JSON.parse(readFileSync(paths.user, "utf8"));
    const project = JSON.parse(readFileSync(paths.project, "utf8"));
    assert.equal(user.note, "keep user"); assert.equal(project.note, "keep project");
    assert.deepEqual(user.entries[key], { active: true, serviceTier: "priority", custom: "keep" });
    assert.deepEqual(project.entries[key], { active: true });
    assert.equal(user.presets, undefined); assert.equal(project.presetSupport, undefined);
    const map = readMap(paths.map)!;
    assert.equal(map.entries?.[key].routes["openai-responses"]?.auth.api_key, undefined);
    assert.equal(map.entries?.[key].routes["openai-completions"]?.auth.unknown?.source, "manual");
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    const bytes = [paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8"));
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(harness.notifications.filter(({ message }) => message === _test.PRESET_REMOVAL_NOTICE).length, 1);
    assert.deepEqual([paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8")), bytes);
    assert.equal(probes, 0); assert.equal(harness.prompts.length, 0);
  } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("startup scans existing preset data even on blocked routes without enabling features or creating defaults", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home, blockedModels[0]);
  try {
    const paths = configPaths(cwd, home);
    mkdirSync(dirname(paths.project), { recursive: true });
    writeFileSync(paths.project, JSON.stringify({ version: 2, presets: {}, entries: {} }));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(JSON.parse(readFileSync(paths.project, "utf8")).presets, undefined);
    assert.equal(existsSync(paths.user), false); assert.equal(existsSync(paths.map), false);
    assert.equal(harness.notifications.filter(({ message }) => message === _test.PRESET_REMOVAL_NOTICE).length, 1);
    assert.equal(harness.statuses.at(-1)?.value, undefined);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("a broken settings scope defers all preset retirement and never reports a removal", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    for (const path of [paths.user, paths.project]) mkdirSync(dirname(path), { recursive: true });
    const user = JSON.stringify({ version: 2, presets: {}, entries: {} });
    const project = "broken private settings";
    const map = JSON.stringify({ version: 2, entries: { [modelKey(openAIModel)!]: { ...manualEntry(openAIModel), source: "preset" } } });
    writeFileSync(paths.user, user); writeFileSync(paths.project, project); writeFileSync(paths.map, map);
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.deepEqual([paths.user, paths.project, paths.map].map((path) => readFileSync(path, "utf8")), [user, project, map]);
    assert.equal(harness.notifications.some(({ message }) => message === _test.PRESET_REMOVAL_NOTICE), false);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier ○ off (config error)");
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("ordinary user-managed data produces no preset-removal notice or passive model probes", async () => {
  const cwd = tempDir(); const home = tempDir();
  const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home);
    writeConfig(paths.user, { entries: { [modelKey(openAIModel)!]: { active: true, serviceTier: "priority" } } });
    writeFixtureMap(paths.map, putRoute({ entries: {} }, manualEntry(openAIModel)));
    const before = [paths.user, paths.map].map((path) => readFileSync(path, "utf8"));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.equal(harness.notifications.some(({ message }) => message === _test.PRESET_REMOVAL_NOTICE), false);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.deepEqual([paths.user, paths.map].map((path) => readFileSync(path, "utf8")), before);
    assert.equal(harness.prompts.length, 0);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

for (const initialAuth of ["oauth", "api_key"] as const) {
  test(`${initialAuth} support is not reused after a same-route auth switch; settings stay active and no probe starts`, async () => {
    const cwd = tempDir(); const home = tempDir();
    const harness = createExtensionHarness(cwd, home);
    let probes = 0;
    const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
    try {
      const paths = configPaths(cwd, home); const key = modelKey(openAIModel)!;
      harness.setAuthMode(initialAuth);
      writeConfig(paths.user, { statusFormat: STATUS_FORMAT_PRESETS.long, unknownModelBehavior: "auto-probe", entries: { [key]: { active: true, serviceTier: "priority" } } });
      writeMap(paths.map, markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported" }), { ...openAIModel as object, provider: "openai", id: "gpt-5.5", api: "openai-responses", authMode: initialAuth }));
      const configBytes = readFileSync(paths.user, "utf8");
      await harness.handlers.get("session_start")?.({} as never, harness.ctx);
      assert.ok(harness.statuses.at(-1)?.value?.includes("probe-verified"));
      const nextAuth = initialAuth === "oauth" ? "api_key" : "oauth";
      harness.setAuthMode(nextAuth);
      const payload = { model: "gpt-5.5", service_tier: "default" };
      assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload } as never, harness.ctx), { model: "gpt-5.5", service_tier: "priority" });
      assert.deepEqual(payload, { model: "gpt-5.5", service_tier: "default" });
      assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | unknown");
      let notices = harness.notifications.filter(({ message }) => message.startsWith("[pi-provider-service-tier] Authentication changed"));
      assert.equal(notices.length, 1);
      assert.equal(notices[0].type, "warning");
      assert.ok(notices[0].message.includes(`${initialAuth} → ${nextAuth}`));
      assert.match(notices[0].message, /Explicit tier settings are unchanged.*still be sent/);
      assert.match(notices[0].message, /Re-confirm.*Auto Probe.*No probe was started/);
      await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
      assert.equal(harness.notifications.filter(({ message }) => message.startsWith("[pi-provider-service-tier] Authentication changed")).length, 1);
      harness.setAuthMode(initialAuth);
      await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
      assert.ok(harness.statuses.at(-1)?.value?.includes("probe-verified"));
      assert.equal(readFileSync(paths.user, "utf8"), configBytes);
      assert.equal(probes, 0); assert.equal(harness.prompts.length, 0);
    } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });
}

test("auth switches use existing records for the new mode rather than mixing observations", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home); const key = modelKey(openAIModel)!;
    const oauth = { ...openAIModel as object, provider: "openai", id: "gpt-5.5", api: "openai-responses", authMode: "oauth" as const };
    let map = markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported" }), openAIModel);
    map = markTierProbeResults(map, key, { priority: { result: "unknown", kind: "fallback", payloadPrepared: true, requestCompleted: true, servedTier: "default", updatedAt: "fixture" } }, oauth);
    writeMap(paths.map, map);
    writeConfig(paths.user, { statusFormat: STATUS_FORMAT_PRESETS.long, entries: { [key]: { active: true, serviceTier: "priority" } } });
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    assert.ok(harness.statuses.at(-1)?.value?.includes("probe-verified"));
    harness.setAuthMode("oauth");
    await harness.handlers.get("model_select")?.({} as never, harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | fallback → default");
    await harness.commands.get("service-tier-project")?.handler("status", harness.ctx);
    assert.ok(harness.notifications.at(-1)?.message.includes("openai-responses, oauth"));
    assert.deepEqual(readMap(paths.map), map);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("historical v3 probe/manual facts migrate to unknown auth without modifying tier settings", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home); const key = modelKey(openAIModel)!;
    writeConfig(paths.user, { statusFormat: STATUS_FORMAT_PRESETS.long, entries: { [key]: { active: true, serviceTier: "priority" } } });
    const configBytes = readFileSync(paths.user, "utf8");
    writeFileSync(paths.map, JSON.stringify({ version: 3, entries: { [key]: { routes: { "openai-responses": {
      ...manualEntry(openAIModel), source: "probe", observations: fixtureResults({ priority: "supported" }), evidence: fixtureResults({ priority: "supported" }),
    } } } } }));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const auth = readMap(paths.map)!.entries![key].routes["openai-responses"].auth;
    assert.equal(auth.api_key, undefined); assert.equal(auth.oauth, undefined);
    assert.equal(auth.unknown?.observations?.priority?.kind, "verified");
    assert.deepEqual(auth.unknown?.tiers, MANUAL_TEST_TIERS);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority | unknown");
    assert.equal(readFileSync(paths.user, "utf8"), configBytes);
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("unknown auth keeps healthy activation but cannot reuse history, create support, or start probes", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  let probes = 0; const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    const paths = configPaths(cwd, home);
    writeMap(paths.map, putRoute({ entries: {} }, manualEntry(openAIModel)));
    const mapBytes = readFileSync(paths.map, "utf8");
    harness.setAuthMode("unknown");
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.deepEqual(await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx), { service_tier: "priority" });
    assert.equal(probes, 0); assert.equal(harness.prompts.length, 0);
    assert.equal(readFileSync(paths.map, "utf8"), mapBytes);
    const notices = harness.notifications.filter(({ message }) => message.includes("Cannot determine OAuth/API-key"));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, "warning");
  } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("a pending support prompt cannot apply its decision after authentication changes", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  const selected = deferred<string>(); const opened = deferred<void>(); let probes = 0;
  (harness.ctx as unknown as { ui: { select: () => Promise<string> } }).ui.select = () => { opened.resolve(); return selected.promise; };
  const restoreProbe = _test.setProbeTierForTest(async () => { probes++; return "supported"; });
  try {
    const paths = configPaths(cwd, home);
    harness.setAuthMode("oauth"); await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    const pending = harness.commands.get("service-tier-project")!.handler("priority", harness.ctx);
    await opened.promise; const bytes = readFileSync(paths.map, "utf8");
    harness.setAuthMode("api_key"); selected.resolve("Always auto-probe");
    await pending; await _test.waitForAutoProbesForTest();
    assert.equal(probes, 0); assert.equal(readConfig(paths.user)?.unknownModelBehavior, undefined);
    assert.equal(readFileSync(paths.map, "utf8"), bytes);
    assert.equal(readConfig(paths.project)?.entries?.[modelKey(openAIModel)!].serviceTier, "priority");
  } finally { restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("an auth change aborts a non-cooperative probe cycle and discards late results without restarting", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  const entered = deferred<void>(); const release = deferred<ProbeTierResult>(); let probes = 0; let signal: AbortSignal | undefined;
  const restoreProbe = _test.setProbeTierForTest(async (_model, _tier, _ctx, currentSignal) => { probes++; signal = currentSignal; entered.resolve(); return release.promise; });
  try {
    const paths = configPaths(cwd, home);
    harness.setAuthMode("oauth"); setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    await harness.commands.get("service-tier-project")?.handler("priority", harness.ctx);
    await entered.promise; const bytes = readFileSync(paths.map, "utf8");
    harness.setAuthMode("api_key");
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    assert.equal(signal?.aborted, true);
    await expectAutoProbesToSettle(); release.resolve("supported"); await Promise.resolve();
    assert.equal(probes, 1); assert.equal(readFileSync(paths.map, "utf8"), bytes);
    assert.equal(harness.statuses.at(-1)?.value, "service_tier: ⚡ priority");
    assert.equal(harness.notifications.some(({ message }) => message.includes("auto-probe completed")), false);
    assert.equal(readConfig(paths.project)?.entries?.[modelKey(openAIModel)!].serviceTier, "priority");
  } finally { release.resolve("unknown"); restoreProbe(); harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("SDK payload/event callbacks cannot verify a request after its authentication mode changes", async () => {
  let mode: AuthMode = "oauth";
  let sent = 0;
  const ctx = { modelRegistry: { ...API_KEY_AUTH, isUsingOAuth: () => mode === "oauth", streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => (async function* () {
    sent++; await options.onPayload?.({}, openAIModel);
    mode = "api_key";
    await options.onProviderStreamEvent?.({ type: "response.completed", response: { service_tier: "priority" } }, openAIModel);
    yield { type: "done" };
  })() }, ui: { notify: () => {} } } as never;
  assert.equal((await _test.defaultProbeTier(openAIModel, "priority", ctx)).result, "unknown");
  assert.equal(sent, 1);
});

test("returning to the original auth mode cannot revive a probe after an observed transition", async () => {
  let mode: AuthMode = "oauth";
  let ctx: ExtensionCommandContext;
  ctx = { model: openAIModel, modelRegistry: { ...API_KEY_AUTH, isUsingOAuth: () => mode === "oauth", streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => (async function* () {
    await options.onPayload?.({}, openAIModel);
    mode = "api_key"; _test.supportScope(ctx);
    mode = "oauth";
    await options.onProviderStreamEvent?.({ type: "response.completed", response: { service_tier: "priority" } }, openAIModel);
    yield { type: "done" };
  })() }, ui: { notify: () => {} } } as never;
  assert.equal((await _test.defaultProbeTier(openAIModel, "priority", ctx)).result, "unknown");
});

test("late request errors cannot contaminate another auth mode; new errors target only the current mode", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home); const key = modelKey(openAIModel)!;
    const oauth = { ...openAIModel as object, provider: "openai", id: "gpt-5.5", api: "openai-responses", authMode: "oauth" as const };
    harness.setAuthMode("oauth");
    writeConfig(paths.user, { entries: { [key]: { active: true, serviceTier: "priority" } } });
    writeMap(paths.map, markTierProbeResults({ entries: {} }, key, fixtureResults({ priority: "supported" }), oauth));
    await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    const bytes = readFileSync(paths.map, "utf8");
    harness.setAuthMode("api_key");
    const error = { message: { role: "assistant", provider: "openai", model: "gpt-5.5", api: "openai-responses", errorMessage: "Invalid service_tier: priority" } } as never;
    await harness.handlers.get("message_end")?.(error, harness.ctx);
    assert.equal(readFileSync(paths.map, "utf8"), bytes);
    await harness.handlers.get("before_provider_request")?.({ payload: {} } as never, harness.ctx);
    await harness.handlers.get("message_end")?.(error, harness.ctx);
    const auth = readMap(paths.map)!.entries![key].routes["openai-responses"].auth;
    assert.equal(auth.oauth?.evidence?.priority?.kind, "verified");
    assert.equal(auth.api_key?.evidence?.priority?.kind, "rejected");
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("support maintenance removes only selected auth or known-auth records and preserves unclassified history", async () => {
  const cwd = tempDir(); const home = tempDir(); const harness = createExtensionHarness(cwd, home);
  try {
    const paths = configPaths(cwd, home); const key = modelKey(openAIModel)!;
    const api = { provider: "openai", id: "gpt-5.5", api: "openai-responses" };
    let map = _test.migrateMapToCurrent({ version: 3, entries: { [key]: { routes: { "openai-responses": { ...manualEntry(openAIModel), authMode: undefined } } } } });
    const original = map.entries![key].routes["openai-responses"].auth.unknown;
    map = putRoute(map, manualEntry(openAIModel));
    map = putRoute(map, { ...manualEntry(openAIModel), authMode: "oauth" });
    writeMap(paths.map, map);
    harness.setAuthMode("oauth"); await harness.handlers.get("session_start")?.({} as never, harness.ctx);
    await harness.commands.get("service-tier-unset-support")?.handler("", harness.ctx);
    let auth = readMap(paths.map)!.entries![key].routes["openai-responses"].auth;
    assert.equal(auth.oauth, undefined); assert.ok(auth.api_key); assert.deepEqual(auth.unknown, original);
    await harness.commands.get("service-tier-unset-support-all")?.handler("", harness.ctx);
    auth = readMap(paths.map)!.entries![key].routes["openai-responses"].auth;
    assert.deepEqual(auth, { unknown: original });
    assert.equal(mapSupportsTier(readMap(paths.map), key, "priority", { ...api, authMode: "oauth" }), false);
  } finally { harness.restore(); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("benchmark rejects blocked providers and model-key overrides before starting Pi", () => {
  const temp = tempDir();
  try {
    for (const overrides of [
      { PST_BENCH_MODEL: "anthropic/blocked-model" },
      { PST_BENCH_MODEL: "google/blocked-model" },
      { PST_BENCH_MODEL: "google-vertex/blocked-model" },
      { PST_BENCH_MODEL: "amazon-bedrock/blocked-model" },
      { PST_BENCH_MODEL: "custom-provider/blocked-model" },
      { PST_BENCH_MODEL: "anthropic/blocked-model", PST_BENCH_MODEL_KEY: "openai/gpt-5.5" },
      { PST_BENCH_MODEL: "openai/gpt-5.5", PST_BENCH_MODEL_KEY: "anthropic/blocked-model" },
      { PST_BENCH_MODEL: "openai/gpt-5.5", PST_BENCH_PROVIDER: "anthropic" },
    ]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/benchmark-service-tier.mjs", import.meta.url))], {
        encoding: "utf8", timeout: 15_000,
        env: {
          ...process.env, HOME: temp, PI_CODING_AGENT_DIR: temp,
          PST_BENCH_PI_BIN: join(temp, "must-not-start-pi"),
          PST_BENCH_MODEL_KEY: "", PST_BENCH_PROVIDER: "", PST_BENCH_TIER: "priority",
          ...overrides,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /benchmarking is blocked for unsupported provider/);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
