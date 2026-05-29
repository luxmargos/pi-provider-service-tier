#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "pi-provider-service-tier";
const CONFIG_BASENAME = "pi-provider-service-tier.json";
const DEFAULT_MODEL = "openai-codex/gpt-5.5";
const DEFAULT_TIER = "priority";
const DEFAULT_MIN_OUTPUT_CHARS = 4_000;
const DEFAULT_PROMPT = `Do not use tools. This is a latency benchmark, so complete the whole task in one visible assistant response.

Your answer is invalid if it is short. Do not answer with only BENCHMARK_COMPLETE. Produce a deterministic technical memo titled "Service Tier Latency Benchmark" with exactly these seven sections:
1. Objective
2. Benchmark workload
3. Expected provider behavior
4. Risks to measurement validity
5. Mitigations
6. Decision rubric
7. Final checklist

Sections 1 through 6 must each contain 170 to 220 words. Section 7 must contain exactly 10 checklist bullets, and each bullet must be a full sentence of at least 18 words. Use concrete engineering language. After the checklist, end with the exact line: BENCHMARK_COMPLETE`;

function envInt(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be an integer >= ${min}.`);
  return value;
}

function promptArgsFromEnv() {
  if (process.env.PST_BENCH_PROMPT_FILE) {
    return [`@${resolve(process.env.PST_BENCH_PROMPT_FILE)}`];
  }
  return [process.env.PST_BENCH_PROMPT || DEFAULT_PROMPT];
}

function promptArgsForRun(basePromptArgs, mode, round) {
  return [
    ...basePromptArgs,
    `Benchmark metadata only: mode=${mode}; round=${round}; nonce=${Date.now()}-${Math.random().toString(16).slice(2)}. Do not mention this metadata.`,
  ];
}

function globalConfigInspection(modelKey) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  const configPath = join(agentDir, "extensions", CONFIG_BASENAME);
  if (!existsSync(configPath)) return { configPath, found: false };
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const entry = config?.entries?.[modelKey];
    return {
      configPath,
      found: true,
      active: entry?.active === true,
      serviceTier: typeof entry?.serviceTier === "string" ? entry.serviceTier : undefined,
    };
  } catch (error) {
    return {
      configPath,
      found: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function modelKeyFromEnv(model, provider) {
  const withoutThinking = model.replace(/:(off|minimal|low|medium|high|xhigh)$/i, "");
  if (withoutThinking.includes("/")) return withoutThinking;
  if (provider) return `${provider}/${withoutThinking}`;
  throw new Error("PST_BENCH_MODEL must include provider/model, or set PST_BENCH_PROVIDER when using a bare model id.");
}

function writeProjectConfig(cwd, modelKey, active, tier) {
  const path = resolve(cwd, ".pi", "extensions", CONFIG_BASENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        aggressiveProbe: false,
        entries: {
          [modelKey]: active ? { active: true, serviceTier: tier } : { active: false, serviceTier: tier },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runPi({ label, cwd, repoRoot, promptArgs, model, provider, thinking, timeoutMs, minOutputChars }) {
  const piBin = process.env.PST_BENCH_PI_BIN || "pi";
  const args = [
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-tools",
    "--no-extensions",
    "-e",
    repoRoot,
    "-p",
    "--model",
    model,
  ];
  if (provider) args.push("--provider", provider);
  if (thinking && thinking !== "default") args.push("--thinking", thinking);
  args.push(...promptArgs);

  return new Promise((resolvePromise, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(piBin, args, {
      cwd,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const completedMarker = stdout.includes("BENCHMARK_COMPLETE");
      const longEnough = stdout.trim().length >= minOutputChars;
      const result = {
        label,
        elapsedMs,
        code,
        signal,
        timedOut,
        stdoutChars: stdout.length,
        stderrTail: stderr.trim().split("\n").slice(-20).join("\n"),
        stdoutTail: stdout.trim().slice(-500),
        completedMarker,
        minOutputChars,
        longEnough,
      };
      if (code === 0 && !timedOut && completedMarker && longEnough) resolvePromise(result);
      else if (code === 0 && !timedOut) {
        reject(Object.assign(new Error(`${label} produced an invalid benchmark response; marker=${completedMarker}, chars=${stdout.trim().length}, min=${minOutputChars}`), { result }));
      } else reject(Object.assign(new Error(`${label} pi run failed with code ${code ?? signal}`), { result }));
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function seconds(ms) {
  return (ms / 1000).toFixed(2);
}

function startModeFromEnv() {
  const raw = (process.env.PST_BENCH_START_WITH || "baseline").trim().toLowerCase();
  if (raw === "baseline" || raw === "off") return "baseline";
  if (raw === "tier" || raw === "priority" || raw === "on") return "tier";
  throw new Error("PST_BENCH_START_WITH must be one of: baseline, off, tier, priority, on.");
}

function orderForRound(round, tier, startMode) {
  const baselineFirst = startMode === "baseline" ? round % 2 === 1 : round % 2 === 0;
  return baselineFirst ? ["baseline", tier] : [tier, "baseline"];
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const model = process.env.PST_BENCH_MODEL || DEFAULT_MODEL;
  const provider = process.env.PST_BENCH_PROVIDER || "";
  const modelKey = process.env.PST_BENCH_MODEL_KEY || modelKeyFromEnv(model, provider);
  const tier = process.env.PST_BENCH_TIER || DEFAULT_TIER;
  const thinking = process.env.PST_BENCH_THINKING || "medium";
  const rounds = envInt("PST_BENCH_ROUNDS", 1);
  const timeoutMs = envInt("PST_BENCH_TIMEOUT_MS", 10 * 60 * 1000);
  const minOutputChars = envInt("PST_BENCH_MIN_CHARS", DEFAULT_MIN_OUTPUT_CHARS, { min: 0 });
  const startMode = startModeFromEnv();
  const basePromptArgs = promptArgsFromEnv();
  const tmpRoot = mkdtempSync(resolve(tmpdir(), `${PACKAGE_NAME}-bench-`));
  const keepTmp = process.env.PST_BENCH_KEEP_TMP === "1";
  const globalConfig = globalConfigInspection(modelKey);

  const results = [];
  try {
    console.log(`Benchmarking ${PACKAGE_NAME}`);
    console.log(`model=${modelKey} cliModel=${model} tier=${tier} thinking=${thinking || "default"} rounds=${rounds} minChars=${minOutputChars} startWith=${startMode}`);
    console.log(`tempCwd=${tmpRoot}`);
    console.log("Global extension discovery is disabled with --no-extensions; this benchmark explicitly loads only this checkout with -e.");
    if (!globalConfig.found) {
      console.log(`No user-global ${PACKAGE_NAME} config found at ${globalConfig.configPath}.`);
    } else if (globalConfig.error) {
      console.log(`Could not inspect user-global config at ${globalConfig.configPath}: ${globalConfig.error}`);
    } else {
      console.log(
        `User-global config for ${modelKey}: ${globalConfig.active ? "active" : "not active"}${globalConfig.serviceTier ? ` (${globalConfig.serviceTier})` : ""}.`,
      );
      console.log("The baseline run still writes a project-local active:false override for this model before starting Pi.");
    }
    console.log("Running with the extension loaded in both cases; only the project service_tier setting changes.\n");

    const runCase = async (round, mode) => {
      const active = mode !== "baseline";
      writeProjectConfig(tmpRoot, modelKey, active, tier);
      const result = await runPi({
        label: `round ${round} ${active ? tier : "baseline(no service_tier)"}`,
        cwd: tmpRoot,
        repoRoot,
        promptArgs: promptArgsForRun(basePromptArgs, active ? tier : "baseline", round),
        model,
        provider,
        thinking,
        timeoutMs,
        minOutputChars,
      });
      results.push({ mode: active ? tier : "baseline", round, ...result });
      console.log(
        `round ${round} ${active ? tier : "baseline"}: ${seconds(result.elapsedMs)}s, chars=${result.stdoutChars}, marker=${result.completedMarker}, longEnough=${result.longEnough}`,
      );
    };

    for (let round = 1; round <= rounds; round++) {
      for (const mode of orderForRound(round, tier, startMode)) await runCase(round, mode);
    }

    const baselineTimes = results.filter((result) => result.mode === "baseline").map((result) => result.elapsedMs);
    const tierTimes = results.filter((result) => result.mode === tier).map((result) => result.elapsedMs);
    const baselineMedian = median(baselineTimes);
    const tierMedian = median(tierTimes);
    const deltaMs = baselineMedian - tierMedian;
    const fasterPct = baselineMedian > 0 ? (deltaMs / baselineMedian) * 100 : 0;

    console.log("\nSummary");
    console.log(`baseline median: ${seconds(baselineMedian)}s`);
    console.log(`${tier} median: ${seconds(tierMedian)}s`);
    console.log(`delta: ${deltaMs >= 0 ? "-" : "+"}${seconds(Math.abs(deltaMs))}s (${fasterPct.toFixed(1)}% ${deltaMs >= 0 ? "faster" : "slower"})`);
    console.log("\nRaw JSON:");
    console.log(JSON.stringify({ model: modelKey, cliModel: model, tier, thinking, rounds, minOutputChars, startMode, results }, null, 2));
  } finally {
    if (keepTmp) console.log(`Keeping temp directory: ${tmpRoot}`);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.result) console.error(JSON.stringify(error.result, null, 2));
  process.exitCode = 1;
});
