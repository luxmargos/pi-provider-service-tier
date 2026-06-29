import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getApiProvider,
  type Api,
  type Context as ProviderContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PACKAGE_NAME = "pi-provider-service-tier";
const CONFIG_BASENAME = "pi-provider-service-tier.json";
const MAP_BASENAME = "pi-provider-service-tier-map.json";
const STATUS_KEY = "pi-provider-service-tier";
const STATUS_LABEL = "service_tier";
const STATUS_ICON = "⚡";
const STATUS_OFF_ICON = "○";
const STATUS_ACTIVE_ICON = "●";
const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[32m";
const CONFIG_VERSION = 2;
const MAP_VERSION = 2;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT = Symbol("probe-timeout");
const PROBE_STATUS_INTERVAL_MS = 120;
const PROBE_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const COMMAND_FAST_PROJECT = "service-tier-fast-project";
const COMMAND_FAST_USER = "service-tier-fast-user";
const COMMAND_FAST_PROJECT_ALIAS = "fast-project";
const COMMAND_FAST_USER_ALIAS = "fast-user";
const COMMAND_TIER_PROJECT = "service-tier-project";
const COMMAND_TIER_USER = "service-tier-user";
const COMMAND_REFRESH_SUPPORT = "service-tier-refresh-support";
const COMMAND_REFRESH_SUPPORT_ALL = "service-tier-refresh-support-all";
const COMMAND_UNSET_SUPPORT = "service-tier-unset-support";
const COMMAND_UNSET_SUPPORT_ALL = "service-tier-unset-support-all";
const COMMAND_UNKNOWN_BEHAVIOR = "service-tier-unknown-behavior";
const COMMAND_DEBUG = "service-tier-debug";

export const SERVICE_TIERS = ["priority", "flex", "default", "auto", "scale"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];
export const UNKNOWN_MODEL_BEHAVIORS = ["ask", "auto-probe", "leave-unknown"] as const;
export type UnknownModelBehavior = (typeof UNKNOWN_MODEL_BEHAVIORS)[number];

export type ConfigScope = "project" | "user";
export type MapSource = "preset" | "probe" | "error" | "manual" | "user-mark";

export interface ServiceTierEntry {
  active?: boolean;
  serviceTier?: ServiceTier;
}

export interface ConfigFile {
  version?: number;
  unknownModelBehavior?: UnknownModelBehavior;
  entries?: Record<string, ServiceTierEntry>;
}

export interface EffectiveConfig {
  unknownModelBehavior: UnknownModelBehavior;
  entries: Record<string, Required<ServiceTierEntry>>;
  paths: ConfigPaths;
}

export interface ConfigPaths {
  project: string;
  user: string;
  map: string;
}

export interface ServiceTierMapEntry {
  provider: string;
  id: string;
  api?: string;
  determined: boolean;
  tiers: ServiceTier[];
  unsupportedTiers?: ServiceTier[];
  source: MapSource;
  updatedAt: string;
  error?: string;
}

export interface ServiceTierMapFile {
  version?: number;
  entries?: Record<string, ServiceTierMapEntry>;
}

const DEFAULT_UNKNOWN_MODEL_BEHAVIOR: UnknownModelBehavior = "ask";

const DEFAULT_CONFIG: ConfigFile = {
  version: CONFIG_VERSION,
  entries: {},
};

const DEFAULT_MAP: Required<ServiceTierMapFile> = {
  version: MAP_VERSION,
  entries: {},
};

interface LastAppliedTier {
  key: string;
  tier: ServiceTier;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isServiceTier(value: unknown): value is ServiceTier {
  return typeof value === "string" && (SERVICE_TIERS as readonly string[]).includes(value);
}

export function isUnknownModelBehavior(value: unknown): value is UnknownModelBehavior {
  return typeof value === "string" && (UNKNOWN_MODEL_BEHAVIORS as readonly string[]).includes(value);
}

function uniqueTiers(values: readonly ServiceTier[]): ServiceTier[] {
  return SERVICE_TIERS.filter((tier) => values.includes(tier));
}

function hasCompleteTierKnowledge(tiers: readonly ServiceTier[], unsupportedTiers: readonly ServiceTier[] = []): boolean {
  return SERVICE_TIERS.every((tier) => tiers.includes(tier) || unsupportedTiers.includes(tier));
}

function parseEntry(value: unknown): ServiceTierEntry | undefined {
  if (!isRecord(value)) return undefined;
  const entry: ServiceTierEntry = {};
  if (typeof value.active === "boolean") entry.active = value.active;
  if (isServiceTier(value.serviceTier)) entry.serviceTier = value.serviceTier;
  return entry;
}

function normalizeEntries(value: unknown): Record<string, ServiceTierEntry> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries: Record<string, ServiceTierEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = normalizeModelKey(rawKey);
    const entry = parseEntry(rawEntry);
    if (key && entry) entries[key] = entry;
  }
  return entries;
}

function normalizeMapEntry(key: string, value: unknown): ServiceTierMapEntry | undefined {
  if (!isRecord(value)) return undefined;
  const parsed = parseModelKey(key);
  const provider = typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : parsed?.provider;
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : parsed?.id;
  if (!provider || !id) return undefined;
  const tiers = Array.isArray(value.tiers) ? uniqueTiers(value.tiers.filter(isServiceTier)) : [];
  const unsupportedTiers = Array.isArray(value.unsupportedTiers)
    ? uniqueTiers(value.unsupportedTiers.filter(isServiceTier))
    : undefined;
  const source =
    value.source === "preset" ||
    value.source === "probe" ||
    value.source === "error" ||
    value.source === "manual" ||
    value.source === "user-mark"
      ? value.source
      : "manual";
  const determined =
    typeof value.determined === "boolean"
      ? value.determined
      : source === "probe"
        ? hasCompleteTierKnowledge(tiers, unsupportedTiers)
        : typeof value.supported === "boolean"
          ? value.supported
          : tiers.length > 0;
  return {
    provider,
    id,
    ...(typeof value.api === "string" ? { api: value.api } : {}),
    determined,
    tiers,
    ...(unsupportedTiers && unsupportedTiers.length > 0 ? { unsupportedTiers } : {}),
    source,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function normalizeMapEntries(value: unknown): Record<string, ServiceTierMapEntry> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries: Record<string, ServiceTierMapEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = normalizeModelKey(rawKey);
    if (!key) continue;
    const entry = normalizeMapEntry(key, rawEntry);
    if (entry) entries[key] = entry;
  }
  return entries;
}

function loadBundledPresetEntries(): Record<string, ServiceTierMapEntry> {
  const presetDir = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");
  if (!existsSync(presetDir)) return {};
  const entries: Record<string, ServiceTierMapEntry> = {};
  for (const file of readdirSync(presetDir).filter((name) => name.endsWith(".json")).sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(presetDir, file), "utf8")) as unknown;
      if (!isRecord(parsed)) continue;
      const normalized = normalizeMapEntries(parsed.entries);
      if (!normalized) continue;
      for (const [key, entry] of Object.entries(normalized)) {
        entries[key] = { ...entry, tiers: [...entry.tiers], source: "preset" };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${PACKAGE_NAME}] Failed to read bundled preset ${file}: ${message}`);
    }
  }
  return entries;
}

const BUNDLED_PRESET_ENTRIES = loadBundledPresetEntries();

type PresetLookupModel = Pick<Model<Api>, "provider"> & Partial<Pick<Model<Api>, "id" | "api">>;

function bundledPresetEntryForModel(model: PresetLookupModel): ServiceTierMapEntry | undefined {
  if (!model.id) return undefined;
  const entry = BUNDLED_PRESET_ENTRIES[`${model.provider}/${model.id}`];
  if (!entry) return undefined;
  if (entry.api && entry.api !== model.api) return undefined;
  return {
    ...entry,
    provider: model.provider,
    id: model.id,
    api: model.api,
    tiers: [...entry.tiers],
    ...(entry.unsupportedTiers ? { unsupportedTiers: [...entry.unsupportedTiers] } : {}),
  };
}

export function parseModelKey(value: string): { provider: string; id: string } | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const id = trimmed.slice(slash + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

export function normalizeModelKey(value: string): string | undefined {
  const parsed = parseModelKey(value);
  return parsed ? `${parsed.provider}/${parsed.id}` : undefined;
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id"> | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export function configPaths(cwd: string, home = homedir()): ConfigPaths {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    user: join(home, ".pi", "agent", "extensions", CONFIG_BASENAME),
    map: join(home, ".pi", "agent", "extensions", MAP_BASENAME),
  };
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${PACKAGE_NAME}] Failed to read ${path}: ${message}`);
    return undefined;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${PACKAGE_NAME}] Failed to write ${path}: ${message}`);
  }
}

function rawFileVersion(value: unknown): number {
  if (!isRecord(value)) return 1;
  return typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0 ? value.version : 1;
}

function migrateConfigV1ToV2(value: unknown): ConfigFile {
  if (!isRecord(value)) return { ...DEFAULT_CONFIG };
  const config: ConfigFile = { version: 2 };
  const rawUnknownBehavior = value.unknownModelBehavior ?? value.unsupportedModelBehavior;
  if (isUnknownModelBehavior(rawUnknownBehavior)) config.unknownModelBehavior = rawUnknownBehavior;
  const entries = normalizeEntries(value.entries);
  if (entries !== undefined) config.entries = entries;
  return config;
}

function migrateConfigToCurrent(value: unknown): ConfigFile {
  let version = rawFileVersion(value);
  let next: unknown = value;
  while (version < CONFIG_VERSION) {
    if (version === 1) {
      next = migrateConfigV1ToV2(next);
      version = 2;
      continue;
    }
    break;
  }
  if (!isRecord(next)) return { version: CONFIG_VERSION };
  const config = migrateConfigV1ToV2(next);
  return { ...config, version: CONFIG_VERSION };
}

export function readConfig(path: string): ConfigFile | undefined {
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  return migrateConfigToCurrent(parsed);
}

export function writeConfig(path: string, config: ConfigFile): void {
  writeJsonFile(path, {
    version: CONFIG_VERSION,
    ...(config.unknownModelBehavior ? { unknownModelBehavior: config.unknownModelBehavior } : {}),
    entries: config.entries ?? {},
  });
}

function migrateConfigFile(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  const migrated = migrateConfigToCurrent(parsed);
  writeConfig(path, migrated);
  return migrated;
}

export function ensureConfig(path: string): ConfigFile {
  const existing = readConfig(path);
  if (existing) return existing;
  writeConfig(path, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

function migrateMapV1ToV2(value: unknown): ServiceTierMapFile {
  if (!isRecord(value)) return { ...DEFAULT_MAP };
  return { version: 2, entries: normalizeMapEntries(value.entries) ?? {} };
}

function migrateMapToCurrent(value: unknown): ServiceTierMapFile {
  let version = rawFileVersion(value);
  let next: unknown = value;
  while (version < MAP_VERSION) {
    if (version === 1) {
      next = migrateMapV1ToV2(next);
      version = 2;
      continue;
    }
    break;
  }
  if (!isRecord(next)) return { version: MAP_VERSION, entries: {} };
  if (rawFileVersion(next) < MAP_VERSION) return migrateMapV1ToV2(next);
  return { version: MAP_VERSION, entries: normalizeMapEntries(next.entries) ?? {} };
}

export function readMap(path: string): ServiceTierMapFile | undefined {
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  return migrateMapToCurrent(parsed);
}

export function writeMap(path: string, map: ServiceTierMapFile): void {
  writeJsonFile(path, {
    version: MAP_VERSION,
    entries: map.entries ?? {},
  });
}

function migrateMapFile(path: string): ServiceTierMapFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  const migrated = migrateMapToCurrent(parsed);
  writeMap(path, migrated);
  return migrated;
}

export function ensureMap(path: string): ServiceTierMapFile {
  const existing = readMap(path);
  if (existing) return existing;
  writeMap(path, DEFAULT_MAP);
  return { ...DEFAULT_MAP };
}

export function mergeConfigs(userConfig: ConfigFile | undefined, projectConfig: ConfigFile | undefined, paths: ConfigPaths): EffectiveConfig {
  const userEntries = userConfig?.entries ?? {};
  const projectEntries = projectConfig?.entries ?? {};
  const keys = new Set([...Object.keys(userEntries), ...Object.keys(projectEntries)]);
  const entries: Record<string, Required<ServiceTierEntry>> = {};
  for (const key of keys) {
    const merged = { ...userEntries[key], ...projectEntries[key] };
    entries[key] = {
      active: merged.active ?? false,
      serviceTier: merged.serviceTier ?? "priority",
    };
  }
  return {
    unknownModelBehavior:
      projectConfig?.unknownModelBehavior ?? userConfig?.unknownModelBehavior ?? DEFAULT_UNKNOWN_MODEL_BEHAVIOR,
    entries,
    paths,
  };
}

export function resolveEffectiveConfig(cwd: string, home = homedir()): EffectiveConfig {
  const paths = configPaths(cwd, home);
  return mergeConfigs(readConfig(paths.user), readConfig(paths.project), paths);
}

function readScopeConfig(paths: ConfigPaths, scope: ConfigScope): ConfigFile {
  return ensureConfig(scope === "project" ? paths.project : paths.user);
}

function writeScopeConfig(paths: ConfigPaths, scope: ConfigScope, config: ConfigFile): void {
  writeConfig(scope === "project" ? paths.project : paths.user, config);
}

export function setScopedEntry(paths: ConfigPaths, scope: ConfigScope, key: string, patch: ServiceTierEntry): ConfigFile {
  const config = readScopeConfig(paths, scope);
  const normalized = normalizeModelKey(key);
  if (!normalized) return config;
  const entries = { ...(config.entries ?? {}) };
  entries[normalized] = { ...(entries[normalized] ?? {}), ...patch };
  const next = { ...config, entries };
  writeScopeConfig(paths, scope, next);
  return next;
}

export function setScopedUnknownModelBehavior(
  paths: ConfigPaths,
  scope: ConfigScope,
  unknownModelBehavior: UnknownModelBehavior,
): ConfigFile {
  const config = readScopeConfig(paths, scope);
  const next = { ...config, unknownModelBehavior };
  writeScopeConfig(paths, scope, next);
  return next;
}

export function presetTiersForModel(model: PresetLookupModel): ServiceTier[] {
  const bundled = bundledPresetEntryForModel(model);
  if (bundled) return [...bundled.tiers];
  if (model.provider === "openai" && (model.api === "openai-responses" || model.api === "openai-completions")) {
    return [...SERVICE_TIERS];
  }
  if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
    return ["priority"];
  }
  return [];
}

export function buildPresetMapEntry(model: Pick<Model<Api>, "provider" | "id"> & Partial<Pick<Model<Api>, "api">>): ServiceTierMapEntry {
  const bundled = bundledPresetEntryForModel(model);
  if (bundled) return bundled;
  const tiers = presetTiersForModel(model);
  return {
    provider: model.provider,
    id: model.id,
    ...(model.api ? { api: model.api } : {}),
    determined: tiers.length > 0,
    tiers,
    source: "preset",
    updatedAt: new Date().toISOString(),
  };
}

export function mapSupportsTier(map: ServiceTierMapFile | undefined, key: string | undefined, tier: ServiceTier | undefined): boolean {
  if (!map?.entries || !key || !tier) return false;
  const entry = map.entries[key];
  if (!entry || !entry.determined) return false;
  if (entry.unsupportedTiers?.includes(tier)) return false;
  return entry.tiers.includes(tier);
}

export function mapSupportState(
  map: ServiceTierMapFile | undefined,
  key: string | undefined,
  tier: ServiceTier | undefined,
): "supported" | "unknown" {
  if (!map?.entries || !key || !tier) return "unknown";
  const entry = map.entries[key];
  if (!entry) return "unknown";
  return mapSupportsTier(map, key, tier) ? "supported" : "unknown";
}

function probeEntryKnowsTier(entry: ServiceTierMapEntry | undefined, tier: ServiceTier | undefined): boolean {
  if (!entry || !tier || entry.source !== "probe") return false;
  return entry.tiers.includes(tier) || (entry.unsupportedTiers?.includes(tier) ?? false);
}

export function configuredTierForModel(config: EffectiveConfig, model: Model<Api> | undefined): ServiceTier | undefined {
  const key = modelKey(model);
  if (!key) return undefined;
  const entry = config.entries[key];
  return entry?.active ? entry.serviceTier : undefined;
}

export function resolveTierForModel(config: EffectiveConfig, map: ServiceTierMapFile, model: Model<Api> | undefined): ServiceTier | undefined {
  const key = modelKey(model);
  const tier = configuredTierForModel(config, model);
  return mapSupportsTier(map, key, tier) ? tier : undefined;
}

function payloadWithServiceTier(payload: unknown, tier: ServiceTier): unknown | undefined {
  if (!isRecord(payload)) return undefined;
  return { ...payload, service_tier: tier };
}

export function isUnsupportedServiceTierError(message: string | undefined): boolean {
  if (!message) return false;
  return /service[_\s-]?tier/i.test(message) && /unsupported|not\s+supported|invalid|unknown|unrecognized|not\s+recognized|extra_forbidden|unknown\s+parameter|unrecognized\s+request/i.test(message);
}

export function markTierUnsupported(map: ServiceTierMapFile, key: string, tier: ServiceTier, error?: string): ServiceTierMapFile {
  const parsed = parseModelKey(key);
  if (!parsed) return map;
  const entries = { ...(map.entries ?? {}) };
  const existing = entries[key];
  const tiers = uniqueTiers((existing?.tiers ?? []).filter((value) => value !== tier));
  const unsupportedTiers = uniqueTiers([...(existing?.unsupportedTiers ?? []), tier]);
  entries[key] = {
    provider: existing?.provider ?? parsed.provider,
    id: existing?.id ?? parsed.id,
    ...(existing?.api ? { api: existing.api } : {}),
    determined: false,
    tiers,
    unsupportedTiers,
    source: "error",
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  return { version: MAP_VERSION, entries };
}

export function markTierSupported(map: ServiceTierMapFile, key: string, tier: ServiceTier, model?: Pick<Model<Api>, "api">): ServiceTierMapFile {
  const parsed = parseModelKey(key);
  if (!parsed) return map;
  const entries = { ...(map.entries ?? {}) };
  const existing = entries[key];
  const tiers = uniqueTiers([...(existing?.tiers ?? []), tier]);
  const unsupportedTiers = uniqueTiers((existing?.unsupportedTiers ?? []).filter((value) => value !== tier));
  entries[key] = {
    provider: existing?.provider ?? parsed.provider,
    id: existing?.id ?? parsed.id,
    ...(model?.api || existing?.api ? { api: model?.api ?? existing?.api } : {}),
    determined: existing?.determined ?? true,
    tiers,
    ...(unsupportedTiers.length > 0 ? { unsupportedTiers } : {}),
    source: existing?.source === "preset" ? "preset" : "manual",
    updatedAt: new Date().toISOString(),
  };
  return { version: MAP_VERSION, entries };
}

export function markTierProbeResults(
  map: ServiceTierMapFile,
  key: string,
  results: Record<ServiceTier, Exclude<ProbeTierResult, "unknown">>,
  model?: Pick<Model<Api>, "provider" | "id" | "api">,
  error?: string,
): ServiceTierMapFile {
  const parsed = parseModelKey(key);
  if (!parsed) return map;
  const entries = { ...(map.entries ?? {}) };
  const existing = entries[key];
  const tiers = SERVICE_TIERS.filter((tier) => results[tier] === "supported");
  const unsupportedTiers = SERVICE_TIERS.filter((tier) => results[tier] === "unsupported");
  entries[key] = {
    provider: model?.provider ?? existing?.provider ?? parsed.provider,
    id: model?.id ?? existing?.id ?? parsed.id,
    ...(model?.api || existing?.api ? { api: model?.api ?? existing?.api } : {}),
    determined: true,
    tiers,
    ...(unsupportedTiers.length > 0 ? { unsupportedTiers } : {}),
    source: "probe",
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  return { version: MAP_VERSION, entries };
}

export function markTierUserMarked(
  map: ServiceTierMapFile,
  key: string,
  tier: ServiceTier,
  model?: Pick<Model<Api>, "provider" | "id" | "api">,
): ServiceTierMapFile {
  const parsed = parseModelKey(key);
  if (!parsed) return map;
  const entries = { ...(map.entries ?? {}) };
  const existing = entries[key];
  entries[key] = {
    provider: model?.provider ?? existing?.provider ?? parsed.provider,
    id: model?.id ?? existing?.id ?? parsed.id,
    ...(model?.api || existing?.api ? { api: model?.api ?? existing?.api } : {}),
    determined: false,
    tiers: [...(existing?.tiers ?? [])],
    ...(existing?.unsupportedTiers && existing.unsupportedTiers.length > 0
      ? { unsupportedTiers: [...existing.unsupportedTiers] }
      : {}),
    source: "user-mark",
    updatedAt: new Date().toISOString(),
  };
  return { version: MAP_VERSION, entries };
}

function colorStatus(text: string, color?: "green"): string {
  if (!color) return text;
  if (process.env.NO_COLOR) return text;
  return `${ANSI_GREEN}${text}${ANSI_RESET}`;
}

function statusText(config: EffectiveConfig, map: ServiceTierMapFile, model: Model<Api> | undefined): string | undefined {
  const key = modelKey(model);
  if (!key) return undefined;
  const entry = config.entries[key];
  if (!entry?.active) return colorStatus(`${STATUS_LABEL} ${STATUS_OFF_ICON} off`);
  const support = mapSupportState(map, key, entry.serviceTier);
  const supported = support === "supported";
  const prefix = entry.serviceTier === "priority" ? STATUS_ICON : STATUS_ACTIVE_ICON;
  const text = `${STATUS_LABEL}: ${prefix} ${entry.serviceTier}${supported ? "" : ` ${support}`}`;
  return colorStatus(text, supported ? "green" : undefined);
}

function getCwd(ctx: ExtensionContext): string {
  return ctx.cwd || process.cwd();
}

function getPaths(ctx: ExtensionContext): ConfigPaths {
  return configPaths(getCwd(ctx));
}

function seedPresetMapEntryIfMissing(path: string, map: ServiceTierMapFile, model: Model<Api> | undefined): ServiceTierMapFile {
  const key = modelKey(model);
  if (!model || !key || map.entries?.[key]) return map;
  const next = {
    version: MAP_VERSION,
    entries: { ...(map.entries ?? {}), [key]: buildPresetMapEntry(model) },
  };
  writeMap(path, next);
  return next;
}

function refreshPresetMapEntry(
  path: string,
  map: ServiceTierMapFile,
  model: Model<Api> | undefined,
  preserveKnownProbeTier?: ServiceTier,
): ServiceTierMapFile {
  const key = modelKey(model);
  if (!model || !key) return map;
  if (probeEntryKnowsTier(map.entries?.[key], preserveKnownProbeTier)) return map;
  const preset = buildPresetMapEntry(model);
  if (map.entries?.[key]?.source === "user-mark" && !preset.determined) return map;
  const next = {
    version: MAP_VERSION,
    entries: { ...(map.entries ?? {}), [key]: preset },
  };
  writeMap(path, next);
  return next;
}

function refreshPresetKnowledgeForStoredEntries(path: string, map: ServiceTierMapFile): ServiceTierMapFile {
  const entries = { ...(map.entries ?? {}) };
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.source === "probe") continue;
    const preset = buildPresetMapEntry(entry);
    if (preset.determined) entries[key] = preset;
  }
  const next = { version: MAP_VERSION, entries };
  writeMap(path, next);
  return next;
}

function migrateStartupFiles(paths: ConfigPaths): ServiceTierMapFile {
  migrateConfigFile(paths.user);
  migrateConfigFile(paths.project);
  const migratedMap = migrateMapFile(paths.map);
  return migratedMap ?? ensureMap(paths.map);
}

function loadState(ctx: ExtensionContext): { config: EffectiveConfig; map: ServiceTierMapFile } {
  const paths = getPaths(ctx);
  const config = mergeConfigs(readConfig(paths.user), readConfig(paths.project), paths);
  const map = ensureMap(paths.map);
  return { config, map };
}

function updateStatus(ctx: ExtensionContext): void {
  const { config, map } = loadState(ctx);
  ctx.ui.setStatus(STATUS_KEY, statusText(config, map, ctx.model) ?? undefined);
}

function startProbeStatus(ctx: ExtensionContext): { update: (tier: ServiceTier, index: number, total: number) => void; stop: () => void } {
  let index = 0;
  let label = "probing";
  const render = () => {
    const frame = PROBE_STATUS_FRAMES[index % PROBE_STATUS_FRAMES.length];
    ctx.ui.setStatus(STATUS_KEY, colorStatus(`${STATUS_LABEL} ${frame} ${label}`));
    index += 1;
  };
  render();
  const timer = setInterval(render, PROBE_STATUS_INTERVAL_MS);
  return {
    update: (tier, tierIndex, total) => {
      label = `probing ${tier} ${tierIndex}/${total}`;
      render();
    },
    stop: () => {
      clearInterval(timer);
      updateStatus(ctx);
    },
  };
}

type ProbeTierResult = "supported" | "unsupported" | "unknown";
type ProbeTierFunction = (model: Model<Api>, tier: ServiceTier, ctx: ExtensionCommandContext) => Promise<ProbeTierResult>;

async function defaultProbeTier(model: Model<Api>, tier: ServiceTier, ctx: ExtensionCommandContext): Promise<ProbeTierResult> {
  const provider = getApiProvider(model.api);
  if (!provider) return "unknown";
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return "unknown";
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const context: ProviderContext = {
      messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
    };
    const options: SimpleStreamOptions = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 1,
      signal: controller.signal,
      onPayload: (payload) => payloadWithServiceTier(payload, tier) ?? payload,
    };
    const iterator = provider.streamSimple(model, context, options)[Symbol.asyncIterator]();
    const timeoutPromise = new Promise<typeof PROBE_TIMEOUT>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(PROBE_TIMEOUT);
      }, PROBE_TIMEOUT_MS);
    });

    while (true) {
      const next = await Promise.race([iterator.next(), timeoutPromise]);
      if (next === PROBE_TIMEOUT) {
        void iterator.return?.();
        return "unknown";
      }
      if (next.done) return "supported";
      const event = next.value;
      if (event.type === "done") return "supported";
      if (event.type === "error") {
        return isUnsupportedServiceTierError(event.error.errorMessage) ? "unsupported" : "unknown";
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return isUnsupportedServiceTierError(message) ? "unsupported" : "unknown";
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

let probeTier: ProbeTierFunction = defaultProbeTier;
const activeAutoProbes = new Set<Promise<ProbeTierResult>>();

function setProbeTierForTest(next: ProbeTierFunction): () => void {
  const previous = probeTier;
  probeTier = next;
  return () => {
    probeTier = previous;
  };
}

async function waitForAutoProbesForTest(): Promise<void> {
  while (activeAutoProbes.size > 0) {
    await Promise.allSettled([...activeAutoProbes]);
  }
}

async function runAutoProbeForCurrentTier(ctx: ExtensionCommandContext, key: string, tier: ServiceTier): Promise<ProbeTierResult> {
  if (!ctx.model) {
    ctx.ui.notify("No current model selected.", "error");
    return "unknown";
  }
  const paths = getPaths(ctx);
  ctx.ui.notify(`service_tier auto-probe started for ${key}; checking ${SERVICE_TIERS.length} tier(s)...`, "warning");
  const probeStatus = startProbeStatus(ctx);
  const results: Partial<Record<ServiceTier, ProbeTierResult>> = {};
  try {
    for (const [index, currentTier] of SERVICE_TIERS.entries()) {
      probeStatus.update(currentTier, index + 1, SERVICE_TIERS.length);
      results[currentTier] = await probeTier(ctx.model, currentTier, ctx);
    }
  } finally {
    probeStatus.stop();
  }
  const unknownTiers = SERVICE_TIERS.filter((currentTier) => results[currentTier] === "unknown");
  if (unknownTiers.length > 0) {
    ctx.ui.notify(
      `service_tier auto-probe for ${key} did not determine ${unknownTiers.join(", ")}; ${MAP_BASENAME} was not changed.`,
      "warning",
    );
    return results[tier] ?? "unknown";
  }
  const determinedResults = Object.fromEntries(
    SERVICE_TIERS.map((currentTier) => [currentTier, results[currentTier] as Exclude<ProbeTierResult, "unknown">]),
  ) as Record<ServiceTier, Exclude<ProbeTierResult, "unknown">>;
  const supportedTiers = SERVICE_TIERS.filter((currentTier) => determinedResults[currentTier] === "supported");
  const unsupportedTiers = SERVICE_TIERS.filter((currentTier) => determinedResults[currentTier] === "unsupported");
  const map = ensureMap(paths.map);
  writeMap(
    paths.map,
    markTierProbeResults(
      map,
      key,
      determinedResults,
      ctx.model,
      unsupportedTiers.length > 0 ? `service_tier auto-probe rejected: ${unsupportedTiers.join(", ")}` : undefined,
    ),
  );
  updateStatus(ctx);
  if (determinedResults[tier] === "supported") {
    ctx.ui.notify(
      `service_tier auto-probe completed for ${key}; supported: ${supportedTiers.join(", ") || "none"}. Updated ${MAP_BASENAME}.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      `service_tier auto-probe completed for ${key}; ${tier} remains unknown. Updated ${MAP_BASENAME}.`,
      "warning",
    );
  }
  return determinedResults[tier];
}

function startAutoProbeForCurrentTier(ctx: ExtensionCommandContext, key: string, tier: ServiceTier): Promise<ProbeTierResult> {
  const promise = runAutoProbeForCurrentTier(ctx, key, tier).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`service_tier auto-probe failed for ${key}: ${message}`, "error");
    updateStatus(ctx);
    return "unknown" as const;
  });
  activeAutoProbes.add(promise);
  void promise.finally(() => {
    activeAutoProbes.delete(promise);
  });
  return promise;
}

const AUTO_PROBE_ONCE_CHOICE = "Auto-probe once";
const AUTO_PROBE_ALWAYS_CHOICE = "Always auto-probe";
const LEAVE_ONCE_CHOICE = "Leave unknown once";
const LEAVE_ALWAYS_CHOICE = "Always leave unknown";
const UNSUPPORTED_PROMPT_CHOICES = [AUTO_PROBE_ONCE_CHOICE, AUTO_PROBE_ALWAYS_CHOICE, LEAVE_ONCE_CHOICE, LEAVE_ALWAYS_CHOICE] as const;

async function evaluateUnsupportedAfterExplicitCommand(ctx: ExtensionCommandContext, key: string, tier: ServiceTier): Promise<void> {
  const { config, map } = loadState(ctx);
  if (config.unknownModelBehavior === "auto-probe") {
    ctx.ui.notify(`service_tier=${tier} auto-probe behavior will probe all service tiers for ${key} now.`, "info");
    startAutoProbeForCurrentTier(ctx, key, tier);
    return;
  }
  const mapEntry = map.entries?.[key];
  if (mapEntry?.determined) {
    if (mapSupportsTier(map, key, tier)) return;
    ctx.ui.notify(`service_tier=${tier} is not supported by the support map for ${key}; configured requests will still send it.`, "info");
    return;
  }
  if (mapEntry?.source === "user-mark") {
    ctx.ui.notify(`service_tier=${tier} was left unknown for ${key}; configured requests will still send it.`, "info");
    return;
  }
  if (mapSupportState(map, key, tier) !== "unknown") return;
  if (config.unknownModelBehavior === "leave-unknown") {
    ctx.ui.notify(`service_tier=${tier} is not recorded in the support map for ${key}; active configuration will still send it.`, "info");
    return;
  }

  const choice = await ctx.ui.select(
    [
      `service_tier=${tier} is not recorded in the support map for ${key}.`,
      "",
      "Auto-probe sends low-token probe requests for every known service tier and may consume provider tokens.",
    ].join("\n"),
    [...UNSUPPORTED_PROMPT_CHOICES],
  );
  const paths = getPaths(ctx);
  if (choice === AUTO_PROBE_ONCE_CHOICE) {
    startAutoProbeForCurrentTier(ctx, key, tier);
    return;
  }
  if (choice === AUTO_PROBE_ALWAYS_CHOICE) {
    setScopedUnknownModelBehavior(paths, "user", "auto-probe");
    updateStatus(ctx);
    ctx.ui.notify(`user-global unknownModelBehavior set to auto-probe; probing service_tier=${tier} for ${key} now.`, "info");
    startAutoProbeForCurrentTier(ctx, key, tier);
    return;
  }
  if (choice === LEAVE_ONCE_CHOICE) {
    if (ctx.model && !buildPresetMapEntry(ctx.model).determined) {
      writeMap(paths.map, markTierUserMarked(ensureMap(paths.map), key, tier, ctx.model));
      updateStatus(ctx);
    }
    ctx.ui.notify(`service_tier=${tier} will remain disabled for ${key} this time.`, "info");
    return;
  }
  if (choice === LEAVE_ALWAYS_CHOICE) {
    if (ctx.model && !buildPresetMapEntry(ctx.model).determined) {
      writeMap(paths.map, markTierUserMarked(ensureMap(paths.map), key, tier, ctx.model));
    }
    setScopedUnknownModelBehavior(paths, "user", "leave-unknown");
    updateStatus(ctx);
    ctx.ui.notify("user-global unknownModelBehavior set to leave-unknown.", "info");
    return;
  }
  ctx.ui.notify("Unsupported service_tier choice cancelled; no behavior changed.", "info");
}

function currentModelKeyOrNotify(ctx: ExtensionCommandContext): string | undefined {
  const key = modelKey(ctx.model);
  if (!key) ctx.ui.notify("No current model selected.", "error");
  return key;
}

function notifyScopeStatus(ctx: ExtensionCommandContext, scope: ConfigScope): void {
  const { config, map } = loadState(ctx);
  const key = modelKey(ctx.model);
  if (!key) return ctx.ui.notify("No current model selected.", "error");
  const effective = config.entries[key];
  const scoped = readScopeConfig(config.paths, scope).entries?.[key];
  const mapEntry = map.entries?.[key];
  const support = effective?.active ? mapSupportState(map, key, effective.serviceTier) : "unknown";
  ctx.ui.notify(
    [
      `${scope} service tier for ${key}: ${scoped?.active ? scoped.serviceTier ?? "priority" : scoped?.active === false ? "off" : "unset"}`,
      `effective: ${effective?.active ? effective.serviceTier : "off"}`,
      `map: ${mapEntry ? (mapEntry.determined ? mapEntry.tiers.join(", ") || "none" : "unknown") : "unknown"}`,
      `support: ${support}`,
      `unknownBehavior: ${config.unknownModelBehavior}`,
    ].join("; "),
    "info",
  );
}

const TIER_COMMAND_ARGS = [...SERVICE_TIERS, "off", "status"] as const;
const TOGGLE_COMMAND_ARGS = ["on", "off", "status"] as const;
const UNKNOWN_BEHAVIOR_COMMAND_ARGS = [...UNKNOWN_MODEL_BEHAVIORS, "status"] as const;

type CompletionValue =
  | (typeof TIER_COMMAND_ARGS)[number]
  | (typeof TOGGLE_COMMAND_ARGS)[number]
  | (typeof UNKNOWN_BEHAVIOR_COMMAND_ARGS)[number];

function valueCompletions(values: readonly CompletionValue[], prefix: string) {
  const clean = prefix.trim().toLowerCase();
  const items = values.filter((value) => value.startsWith(clean));
  return items.length ? items.map((value) => ({ value, label: value })) : null;
}

function tierCompletions(prefix: string) {
  return valueCompletions(TIER_COMMAND_ARGS, prefix);
}

function fastCompletions(prefix: string) {
  return valueCompletions(TOGGLE_COMMAND_ARGS, prefix);
}

function unknownBehaviorCompletions(prefix: string) {
  return valueCompletions(UNKNOWN_BEHAVIOR_COMMAND_ARGS, prefix);
}

function debugCompletions(prefix: string) {
  return valueCompletions(TOGGLE_COMMAND_ARGS, prefix);
}

function installCommandArgumentAutocomplete(ctx: ExtensionContext): void {
  ctx.ui.addAutocompleteProvider((current) => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const commandCompletions: Record<string, (prefix: string) => ReturnType<typeof tierCompletions>> = {
        [COMMAND_TIER_PROJECT]: tierCompletions,
        [COMMAND_TIER_USER]: tierCompletions,
        [COMMAND_FAST_PROJECT]: fastCompletions,
        [COMMAND_FAST_USER]: fastCompletions,
        [COMMAND_FAST_PROJECT_ALIAS]: fastCompletions,
        [COMMAND_FAST_USER_ALIAS]: fastCompletions,
        [COMMAND_UNKNOWN_BEHAVIOR]: unknownBehaviorCompletions,
        [COMMAND_DEBUG]: debugCompletions,
      };

      for (const [command, complete] of Object.entries(commandCompletions)) {
        const commandPrefix = `/${command} `;
        if (!beforeCursor.startsWith(commandPrefix)) continue;
        const argumentPrefix = beforeCursor.slice(commandPrefix.length);
        if (/\s/.test(argumentPrefix)) continue;
        const items = complete(argumentPrefix);
        if (items) return { items, prefix: argumentPrefix };
        break;
      }

      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  }));
}

async function handleTierCommand(scope: ConfigScope, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = args.trim().toLowerCase();
  const paths = getPaths(ctx);
  ensureConfig(scope === "project" ? paths.project : paths.user);
  const key = currentModelKeyOrNotify(ctx);
  if (!key) return;
  if (!arg || arg === "status") {
    updateStatus(ctx);
    return notifyScopeStatus(ctx, scope);
  }
  if (arg === "off") {
    setScopedEntry(paths, scope, key, { active: false });
    updateStatus(ctx);
    ctx.ui.notify(`${scope} service tier disabled for ${key}.`, "info");
    return;
  }
  if (isServiceTier(arg)) {
    setScopedEntry(paths, scope, key, { active: true, serviceTier: arg });
    refreshPresetMapEntry(paths.map, ensureMap(paths.map), ctx.model, arg);
    updateStatus(ctx);
    ctx.ui.notify(`${scope} service tier ${arg} enabled for ${key}.`, "info");
    await evaluateUnsupportedAfterExplicitCommand(ctx, key, arg);
    return;
  }
  ctx.ui.notify(`Usage: /service-tier-${scope === "project" ? "project" : "user"} [${SERVICE_TIERS.join("|")}|off|status]`, "error");
}

async function handleFastCommand(scope: ConfigScope, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = args.trim().toLowerCase();
  const paths = getPaths(ctx);
  ensureConfig(scope === "project" ? paths.project : paths.user);
  const key = currentModelKeyOrNotify(ctx);
  if (!key) return;
  if (arg === "status") {
    updateStatus(ctx);
    return notifyScopeStatus(ctx, scope);
  }
  const scopedEntry = readScopeConfig(paths, scope).entries?.[key];
  const turnOn = arg === "on" ? true : arg === "off" ? false : !(scopedEntry?.active && scopedEntry.serviceTier === "priority");
  setScopedEntry(paths, scope, key, turnOn ? { active: true, serviceTier: "priority" } : { active: false });
  if (turnOn) refreshPresetMapEntry(paths.map, ensureMap(paths.map), ctx.model, "priority");
  updateStatus(ctx);
  ctx.ui.notify(`${scope} fast mode ${turnOn ? "enabled" : "disabled"} for ${key}.`, "info");
  if (turnOn) await evaluateUnsupportedAfterExplicitCommand(ctx, key, "priority");
}

function unknownBehaviorScopeValue(config: ConfigFile | undefined): UnknownModelBehavior | "unset" {
  return config?.unknownModelBehavior ?? "unset";
}

function notifyUnknownBehaviorStatus(ctx: ExtensionCommandContext): void {
  const paths = getPaths(ctx);
  const userConfig = readConfig(paths.user);
  const projectConfig = readConfig(paths.project);
  const effective = mergeConfigs(userConfig, projectConfig, paths);
  ctx.ui.notify(
    `unknownModelBehavior is ${effective.unknownModelBehavior} (project: ${unknownBehaviorScopeValue(projectConfig)}; user: ${unknownBehaviorScopeValue(userConfig)}).`,
    "info",
  );
}

async function handleUnknownBehaviorCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (!arg || arg === "status") return notifyUnknownBehaviorStatus(ctx);
  if (!isUnknownModelBehavior(arg)) {
    ctx.ui.notify("Usage: /service-tier-unknown-behavior [ask|auto-probe|leave-unknown|status]", "error");
    return;
  }
  const paths = getPaths(ctx);
  setScopedUnknownModelBehavior(paths, "user", arg);
  updateStatus(ctx);
  ctx.ui.notify(`user-global unknownModelBehavior set to ${arg}.`, "info");
}

function upsertMapEntry(path: string, entry: ServiceTierMapEntry): ServiceTierMapFile {
  const map = ensureMap(path);
  const key = `${entry.provider}/${entry.id}`;
  const next = { version: MAP_VERSION, entries: { ...(map.entries ?? {}), [key]: entry } };
  writeMap(path, next);
  return next;
}

function removeMapEntry(path: string, key: string): ServiceTierMapFile {
  const map = ensureMap(path);
  const entries = { ...(map.entries ?? {}) };
  delete entries[key];
  const next = { version: MAP_VERSION, entries };
  writeMap(path, next);
  return next;
}

function clearMap(path: string): ServiceTierMapFile {
  const next = { version: MAP_VERSION, entries: {} };
  writeMap(path, next);
  return next;
}

async function handleRefreshSupport(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.model) return ctx.ui.notify("No current model selected.", "error");
  const paths = getPaths(ctx);
  const key = modelKey(ctx.model);
  if (!key) return ctx.ui.notify("No current model selected.", "error");
  const entry = buildPresetMapEntry(ctx.model);
  upsertMapEntry(paths.map, entry);
  updateStatus(ctx);
  ctx.ui.notify(`service_tier support refreshed for ${entry.provider}/${entry.id}: ${entry.tiers.join(", ") || "unknown"}.`, "info");
  const { config } = loadState(ctx);
  const tier = configuredTierForModel(config, ctx.model);
  if (tier) await evaluateUnsupportedAfterExplicitCommand(ctx, key, tier);
}

async function handleRefreshSupportAll(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getPaths(ctx);
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) return ctx.ui.notify("No available models found.", "warning");
  let updated = 0;
  for (const model of models) {
    const entry = buildPresetMapEntry(model);
    upsertMapEntry(paths.map, entry);
    updated++;
  }
  updateStatus(ctx);
  ctx.ui.notify(`service_tier support refreshed for ${updated} model(s) from presets.`, "info");
  const { config } = loadState(ctx);
  const key = modelKey(ctx.model);
  const tier = configuredTierForModel(config, ctx.model);
  if (key && tier) await evaluateUnsupportedAfterExplicitCommand(ctx, key, tier);
}

async function handleUnsetSupport(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getPaths(ctx);
  const key = currentModelKeyOrNotify(ctx);
  if (!key) return;
  removeMapEntry(paths.map, key);
  updateStatus(ctx);
  ctx.ui.notify(`service_tier support is now unknown for ${key}.`, "info");
}

async function handleUnsetSupportAll(ctx: ExtensionCommandContext): Promise<void> {
  const paths = getPaths(ctx);
  clearMap(paths.map);
  updateStatus(ctx);
  ctx.ui.notify("service_tier support map cleared.", "info");
}

export default function piServiceTier(pi: ExtensionAPI): void {
  let lastApplied: LastAppliedTier | undefined;
  let debugEnabled = false;
  let stateCache: { config: EffectiveConfig; map: ServiceTierMapFile } | undefined;

  const invalidateStateCache = () => {
    stateCache = undefined;
  };
  const getCachedState = (ctx: ExtensionContext) => {
    stateCache ??= loadState(ctx);
    return stateCache;
  };
  const refreshStatus = (ctx: ExtensionContext) => {
    stateCache = loadState(ctx);
    ctx.ui.setStatus(STATUS_KEY, statusText(stateCache.config, stateCache.map, ctx.model) ?? undefined);
  };
  const commandHandler = (handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>) => async (args: string, ctx: ExtensionCommandContext) => {
    invalidateStateCache();
    try {
      await handler(args, ctx);
    } finally {
      invalidateStateCache();
    }
  };

  pi.registerCommand(COMMAND_FAST_PROJECT, {
    description: "Toggle project-level priority service_tier for the current provider/model",
    getArgumentCompletions: fastCompletions,
    handler: commandHandler((args, ctx) => handleFastCommand("project", args, ctx)),
  });

  pi.registerCommand(COMMAND_FAST_USER, {
    description: "Toggle user-global priority service_tier for the current provider/model",
    getArgumentCompletions: fastCompletions,
    handler: commandHandler((args, ctx) => handleFastCommand("user", args, ctx)),
  });

  pi.registerCommand(COMMAND_FAST_PROJECT_ALIAS, {
    description: "Alias for /service-tier-fast-project",
    getArgumentCompletions: fastCompletions,
    handler: commandHandler((args, ctx) => handleFastCommand("project", args, ctx)),
  });

  pi.registerCommand(COMMAND_FAST_USER_ALIAS, {
    description: "Alias for /service-tier-fast-user",
    getArgumentCompletions: fastCompletions,
    handler: commandHandler((args, ctx) => handleFastCommand("user", args, ctx)),
  });

  pi.registerCommand(COMMAND_TIER_PROJECT, {
    description: "Manage project-level service_tier for the current provider/model",
    getArgumentCompletions: tierCompletions,
    handler: commandHandler((args, ctx) => handleTierCommand("project", args, ctx)),
  });

  pi.registerCommand(COMMAND_TIER_USER, {
    description: "Manage user-global service_tier for the current provider/model",
    getArgumentCompletions: tierCompletions,
    handler: commandHandler((args, ctx) => handleTierCommand("user", args, ctx)),
  });

  pi.registerCommand(COMMAND_REFRESH_SUPPORT, {
    description: "Refresh preset service_tier support for the current provider/model",
    handler: commandHandler(async (_args, ctx) => handleRefreshSupport(ctx)),
  });

  pi.registerCommand(COMMAND_REFRESH_SUPPORT_ALL, {
    description: "Refresh preset service_tier support for all available models",
    handler: commandHandler(async (_args, ctx) => handleRefreshSupportAll(ctx)),
  });

  pi.registerCommand(COMMAND_UNSET_SUPPORT, {
    description: "Remove stored service_tier support for the current provider/model",
    handler: commandHandler(async (_args, ctx) => handleUnsetSupport(ctx)),
  });

  pi.registerCommand(COMMAND_UNSET_SUPPORT_ALL, {
    description: "Clear stored service_tier support for all models",
    handler: commandHandler(async (_args, ctx) => handleUnsetSupportAll(ctx)),
  });

  pi.registerCommand(COMMAND_UNKNOWN_BEHAVIOR, {
    description: "Set user-global behavior for unknown service_tier support",
    getArgumentCompletions: unknownBehaviorCompletions,
    handler: commandHandler((args, ctx) => handleUnknownBehaviorCommand(args, ctx)),
  });

  pi.registerCommand(COMMAND_DEBUG, {
    description: "Toggle service_tier injection debug notifications for this Pi session",
    getArgumentCompletions: debugCompletions,
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg || arg === "status") {
        ctx.ui.notify(`service_tier debug is ${debugEnabled ? "on" : "off"}.`, "info");
        return;
      }
      if (arg === "on") {
        debugEnabled = true;
        ctx.ui.notify("service_tier debug enabled for this Pi session.", "info");
        return;
      }
      if (arg === "off") {
        debugEnabled = false;
        ctx.ui.notify("service_tier debug disabled for this Pi session.", "info");
        return;
      }
      ctx.ui.notify("Usage: /service-tier-debug [on|off|status]", "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    installCommandArgumentAutocomplete(ctx);
    const paths = getPaths(ctx);
    refreshPresetKnowledgeForStoredEntries(paths.map, migrateStartupFiles(paths));
    invalidateStateCache();
    refreshStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    invalidateStateCache();
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    invalidateStateCache();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const { config } = getCachedState(ctx);
    const key = modelKey(ctx.model);
    const tier = configuredTierForModel(config, ctx.model);
    const nextPayload = tier ? payloadWithServiceTier(event.payload, tier) : undefined;
    if (!key || !tier || nextPayload === undefined) {
      if (debugEnabled) {
        const requestedTier = key ? config.entries[key]?.serviceTier : undefined;
        ctx.ui.notify(
          `service_tier debug: no injection for ${key ?? "unknown model"}${requestedTier ? ` requested=${requestedTier}` : ""}.`,
          "info",
        );
      }
      return undefined;
    }
    lastApplied = { key, tier, at: Date.now() };
    if (debugEnabled) {
      ctx.ui.notify(`service_tier debug: injected service_tier=${tier} into ${key} request.`, "info");
    }
    return nextPayload;
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!lastApplied) return;
    if (Date.now() - lastApplied.at > 10 * 60 * 1000) {
      lastApplied = undefined;
      return;
    }
    const errorMessage = event.message.errorMessage;
    if (!isUnsupportedServiceTierError(errorMessage)) {
      lastApplied = undefined;
      return;
    }
    const paths = getPaths(ctx);
    const map = ensureMap(paths.map);
    const next = markTierUnsupported(map, lastApplied.key, lastApplied.tier, errorMessage);
    writeMap(paths.map, next);
    invalidateStateCache();
    refreshStatus(ctx);
    ctx.ui.notify(
      `service_tier=${lastApplied.tier} failed for ${lastApplied.key}; updated ${MAP_BASENAME}. The failed request was not retried.`,
      "warning",
    );
    lastApplied = undefined;
  });
}

export const _test = {
  CONFIG_BASENAME,
  MAP_BASENAME,
  STATUS_KEY,
  STATUS_ICON,
  STATUS_OFF_ICON,
  STATUS_ACTIVE_ICON,
  ANSI_RESET,
  ANSI_GREEN,
  DEFAULT_CONFIG,
  DEFAULT_MAP,
  DEFAULT_UNKNOWN_MODEL_BEHAVIOR,
  PACKAGE_NAME,
  COMMAND_FAST_PROJECT,
  COMMAND_FAST_USER,
  COMMAND_FAST_PROJECT_ALIAS,
  COMMAND_FAST_USER_ALIAS,
  COMMAND_TIER_PROJECT,
  COMMAND_TIER_USER,
  COMMAND_REFRESH_SUPPORT,
  COMMAND_REFRESH_SUPPORT_ALL,
  COMMAND_UNSET_SUPPORT,
  COMMAND_UNSET_SUPPORT_ALL,
  COMMAND_UNKNOWN_BEHAVIOR,
  COMMAND_DEBUG,
  TIER_COMMAND_ARGS,
  TOGGLE_COMMAND_ARGS,
  UNKNOWN_BEHAVIOR_COMMAND_ARGS,
  valueCompletions,
  unknownBehaviorCompletions,
  unknownBehaviorScopeValue,
  payloadWithServiceTier,
  statusText,
  colorStatus,
  migrateConfigToCurrent,
  migrateMapToCurrent,
  migrateStartupFiles,
  seedPresetMapEntryIfMissing,
  refreshPresetMapEntry,
  refreshPresetKnowledgeForStoredEntries,
  runAutoProbeForCurrentTier,
  startAutoProbeForCurrentTier,
  setProbeTierForTest,
  waitForAutoProbesForTest,
};
