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
const STATUS_ICON = "⚡";
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT = Symbol("probe-timeout");
const ANSI_RESET = "\u001b[0m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";

const COMMAND_FAST_PROJECT = "fast-project";
const COMMAND_FAST_USER = "fast-user";
const COMMAND_TIER_PROJECT = "service-tier-project";
const COMMAND_TIER_USER = "service-tier-user";
const COMMAND_BUILD_MAP = "service-tier-build-map";
const COMMAND_BUILD_MAP_ALL = "service-tier-build-map-all";
const COMMAND_DEBUG = "service-tier-debug";

export const SERVICE_TIERS = ["priority", "flex", "default", "auto", "scale"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export type ConfigScope = "project" | "user";
export type MapSource = "preset" | "probe" | "error" | "manual";

export interface ServiceTierEntry {
  active?: boolean;
  serviceTier?: ServiceTier;
}

export interface ConfigFile {
  version?: number;
  aggressiveProbe?: boolean;
  entries?: Record<string, ServiceTierEntry>;
}

export interface EffectiveConfig {
  aggressiveProbe: boolean;
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
  supported: boolean;
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

const DEFAULT_CONFIG: Required<ConfigFile> = {
  version: 1,
  aggressiveProbe: false,
  entries: {},
};

const DEFAULT_MAP: Required<ServiceTierMapFile> = {
  version: 1,
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

function uniqueTiers(values: readonly ServiceTier[]): ServiceTier[] {
  return SERVICE_TIERS.filter((tier) => values.includes(tier));
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
    value.source === "preset" || value.source === "probe" || value.source === "error" || value.source === "manual"
      ? value.source
      : "manual";
  return {
    provider,
    id,
    ...(typeof value.api === "string" ? { api: value.api } : {}),
    supported: typeof value.supported === "boolean" ? value.supported : tiers.length > 0,
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

type PresetLookupModel = Pick<Model<Api>, "provider" | "api"> & Partial<Pick<Model<Api>, "id">>;

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

export function readConfig(path: string): ConfigFile | undefined {
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  if (!isRecord(parsed)) return {};
  const config: ConfigFile = {};
  if (typeof parsed.version === "number") config.version = parsed.version;
  if (typeof parsed.aggressiveProbe === "boolean") config.aggressiveProbe = parsed.aggressiveProbe;
  const entries = normalizeEntries(parsed.entries);
  if (entries !== undefined) config.entries = entries;
  return config;
}

export function writeConfig(path: string, config: ConfigFile): void {
  writeJsonFile(path, {
    version: config.version ?? DEFAULT_CONFIG.version,
    aggressiveProbe: config.aggressiveProbe ?? DEFAULT_CONFIG.aggressiveProbe,
    entries: config.entries ?? {},
  });
}

export function ensureConfig(path: string): ConfigFile {
  const existing = readConfig(path);
  if (existing) return existing;
  writeConfig(path, DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function readMap(path: string): ServiceTierMapFile | undefined {
  const parsed = readJsonFile(path);
  if (parsed === undefined) return undefined;
  if (!isRecord(parsed)) return {};
  const map: ServiceTierMapFile = {};
  if (typeof parsed.version === "number") map.version = parsed.version;
  const entries = normalizeMapEntries(parsed.entries);
  if (entries !== undefined) map.entries = entries;
  return map;
}

export function writeMap(path: string, map: ServiceTierMapFile): void {
  writeJsonFile(path, {
    version: map.version ?? DEFAULT_MAP.version,
    entries: map.entries ?? {},
  });
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
    aggressiveProbe: projectConfig?.aggressiveProbe ?? userConfig?.aggressiveProbe ?? DEFAULT_CONFIG.aggressiveProbe,
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

export function buildPresetMapEntry(model: Pick<Model<Api>, "provider" | "id" | "api">): ServiceTierMapEntry {
  const bundled = bundledPresetEntryForModel(model);
  if (bundled) return bundled;
  const tiers = presetTiersForModel(model);
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    supported: tiers.length > 0,
    tiers,
    source: "preset",
    updatedAt: new Date().toISOString(),
  };
}

export function mapSupportsTier(map: ServiceTierMapFile | undefined, key: string | undefined, tier: ServiceTier | undefined): boolean {
  if (!map?.entries || !key || !tier) return false;
  const entry = map.entries[key];
  if (!entry || !entry.supported) return false;
  if (entry.unsupportedTiers?.includes(tier)) return false;
  return entry.tiers.includes(tier);
}

export function resolveTierForModel(config: EffectiveConfig, map: ServiceTierMapFile, model: Model<Api> | undefined): ServiceTier | undefined {
  const key = modelKey(model);
  if (!key) return undefined;
  const entry = config.entries[key];
  if (!entry?.active) return undefined;
  return mapSupportsTier(map, key, entry.serviceTier) ? entry.serviceTier : undefined;
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
    supported: tiers.length > 0,
    tiers,
    unsupportedTiers,
    source: "error",
    updatedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  return { version: map.version ?? DEFAULT_MAP.version, entries };
}

function colorStatus(text: string, color: "green" | "yellow"): string {
  if (process.env.NO_COLOR) return text;
  const ansi = color === "green" ? ANSI_GREEN : ANSI_YELLOW;
  return `${ansi}${text}${ANSI_RESET}`;
}

function statusText(config: EffectiveConfig, map: ServiceTierMapFile, model: Model<Api> | undefined): string | undefined {
  const key = modelKey(model);
  if (!key) return undefined;
  const entry = config.entries[key];
  if (!entry?.active) return undefined;
  const supported = mapSupportsTier(map, key, entry.serviceTier);
  const text = `${STATUS_ICON}${key} ${entry.serviceTier}${supported ? "" : " unsupported"}`;
  return colorStatus(text, supported ? "green" : "yellow");
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
    version: map.version ?? DEFAULT_MAP.version,
    entries: { ...(map.entries ?? {}), [key]: buildPresetMapEntry(model) },
  };
  writeMap(path, next);
  return next;
}

function loadState(ctx: ExtensionContext): { config: EffectiveConfig; map: ServiceTierMapFile } {
  const paths = getPaths(ctx);
  const config = mergeConfigs(readConfig(paths.user), readConfig(paths.project), paths);
  const map = seedPresetMapEntryIfMissing(paths.map, ensureMap(paths.map), ctx.model);
  return { config, map };
}

function updateStatus(ctx: ExtensionContext): void {
  const { config, map } = loadState(ctx);
  ctx.ui.setStatus(STATUS_KEY, statusText(config, map, ctx.model) ?? undefined);
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
  ctx.ui.notify(
    [
      `${scope} service tier for ${key}: ${scoped?.active ? scoped.serviceTier ?? "priority" : scoped?.active === false ? "off" : "unset"}`,
      `effective: ${effective?.active ? effective.serviceTier : "off"}`,
      `map: ${mapEntry ? (mapEntry.supported ? mapEntry.tiers.join(", ") || "none" : "unsupported") : "unknown"}`,
      `aggressiveProbe: ${config.aggressiveProbe ? "on" : "off"}`,
    ].join("; "),
    "info",
  );
}

const TIER_COMMAND_ARGS = [...SERVICE_TIERS, "off", "status"] as const;
const TOGGLE_COMMAND_ARGS = ["on", "off", "status"] as const;

type CompletionValue = (typeof TIER_COMMAND_ARGS)[number] | (typeof TOGGLE_COMMAND_ARGS)[number];

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
    updateStatus(ctx);
    ctx.ui.notify(`${scope} service tier ${arg} enabled for ${key}.`, "info");
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
  updateStatus(ctx);
  ctx.ui.notify(`${scope} fast mode ${turnOn ? "enabled" : "disabled"} for ${key}.`, "info");
}

function upsertMapEntry(path: string, entry: ServiceTierMapEntry): ServiceTierMapFile {
  const map = ensureMap(path);
  const key = `${entry.provider}/${entry.id}`;
  const next = { version: map.version ?? DEFAULT_MAP.version, entries: { ...(map.entries ?? {}), [key]: entry } };
  writeMap(path, next);
  return next;
}

async function probeTier(model: Model<Api>, tier: ServiceTier, ctx: ExtensionCommandContext): Promise<"supported" | "unsupported" | "unknown"> {
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

async function buildMapEntry(model: Model<Api>, aggressiveProbe: boolean, ctx: ExtensionCommandContext): Promise<ServiceTierMapEntry> {
  if (!aggressiveProbe) return buildPresetMapEntry(model);
  const supported: ServiceTier[] = [];
  const unsupported: ServiceTier[] = [];
  for (const tier of SERVICE_TIERS) {
    ctx.ui.notify(`Probing ${model.provider}/${model.id} service_tier=${tier}...`, "info");
    const result = await probeTier(model, tier, ctx);
    if (result === "supported") supported.push(tier);
    if (result === "unsupported") unsupported.push(tier);
  }
  const preset = presetTiersForModel(model);
  const tiers = supported.length > 0 ? uniqueTiers(supported) : preset;
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    supported: tiers.length > 0,
    tiers,
    ...(unsupported.length > 0 ? { unsupportedTiers: uniqueTiers(unsupported) } : {}),
    source: "probe",
    updatedAt: new Date().toISOString(),
  };
}

async function handleBuildMap(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.model) return ctx.ui.notify("No current model selected.", "error");
  const { config } = loadState(ctx);
  const entry = await buildMapEntry(ctx.model, config.aggressiveProbe, ctx);
  upsertMapEntry(config.paths.map, entry);
  updateStatus(ctx);
  ctx.ui.notify(`service_tier map updated for ${entry.provider}/${entry.id}: ${entry.tiers.join(", ") || "unsupported"}.`, "info");
}

async function handleBuildMapAll(ctx: ExtensionCommandContext): Promise<void> {
  const { config } = loadState(ctx);
  const models = ctx.modelRegistry.getAvailable();
  if (models.length === 0) return ctx.ui.notify("No available models found.", "warning");
  ctx.ui.notify(
    `Building service_tier map for ${models.length} available model(s)${config.aggressiveProbe ? " with aggressive probing" : " from presets"}.`,
    config.aggressiveProbe ? "warning" : "info",
  );
  let updated = 0;
  for (const model of models) {
    const entry = await buildMapEntry(model, config.aggressiveProbe, ctx);
    upsertMapEntry(config.paths.map, entry);
    updated++;
  }
  updateStatus(ctx);
  ctx.ui.notify(`service_tier map updated for ${updated} model(s).`, "info");
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

  pi.registerCommand(COMMAND_BUILD_MAP, {
    description: "Build/update service_tier support map for the current provider/model",
    handler: commandHandler(async (_args, ctx) => handleBuildMap(ctx)),
  });

  pi.registerCommand(COMMAND_BUILD_MAP_ALL, {
    description: "Build/update service_tier support map for all available models",
    handler: commandHandler(async (_args, ctx) => handleBuildMapAll(ctx)),
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
    ensureMap(paths.map);
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
    const { config, map } = getCachedState(ctx);
    const key = modelKey(ctx.model);
    const tier = resolveTierForModel(config, map, ctx.model);
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
    if (Date.now() - lastApplied.at > 10 * 60 * 1000) return;
    const errorMessage = event.message.errorMessage;
    if (!isUnsupportedServiceTierError(errorMessage)) return;
    const paths = getPaths(ctx);
    const map = ensureMap(paths.map);
    const next = markTierUnsupported(map, lastApplied.key, lastApplied.tier, errorMessage);
    writeMap(paths.map, next);
    invalidateStateCache();
    refreshStatus(ctx);
    ctx.ui.notify(
      `service_tier=${lastApplied.tier} is unsupported for ${lastApplied.key}; updated ${MAP_BASENAME}. The failed request was not retried.`,
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
  ANSI_RESET,
  ANSI_GREEN,
  ANSI_YELLOW,
  DEFAULT_CONFIG,
  DEFAULT_MAP,
  PACKAGE_NAME,
  COMMAND_FAST_PROJECT,
  COMMAND_FAST_USER,
  COMMAND_TIER_PROJECT,
  COMMAND_TIER_USER,
  COMMAND_BUILD_MAP,
  COMMAND_BUILD_MAP_ALL,
  COMMAND_DEBUG,
  TIER_COMMAND_ARGS,
  TOGGLE_COMMAND_ARGS,
  valueCompletions,
  payloadWithServiceTier,
  statusText,
  colorStatus,
  seedPresetMapEntryIfMissing,
};
