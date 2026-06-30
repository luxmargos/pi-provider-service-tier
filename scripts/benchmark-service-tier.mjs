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
const DEFAULT_ROUNDS = 3;
const DEFAULT_WARMUPS = 1;
const DEFAULT_MIN_OUTPUT_CHARS = 4_000;
const DEFAULT_PRACTICAL_DELTA_MS = 750;
const DEFAULT_PRACTICAL_DELTA_PCT = 5;
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
const WORKLOAD_SCENARIOS = [
  "a developer deciding whether priority service tier materially reduces interactive coding latency during a model-heavy refactor",
  "an engineering manager comparing default and paid priority queues during a production incident response simulation",
  "a platform maintainer validating whether provider-side scheduling improvements are visible through Pi's extension hook path",
  "a release engineer deciding whether priority service tier should be enabled only for long-running review and planning prompts",
  "a cost owner weighing lower tail latency against paid service-tier usage for a large agentic codebase",
];

function envInt(name, fallback, { min = 1 } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be an integer >= ${min}.`);
  return value;
}

function envFloat(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} must be a number >= ${min}.`);
  return value;
}

function promptArgsFromEnv() {
  if (process.env.PST_BENCH_PROMPT_FILE) {
    return { args: [`@${resolve(process.env.PST_BENCH_PROMPT_FILE)}`], custom: true };
  }
  if (process.env.PST_BENCH_PROMPT) return { args: [process.env.PST_BENCH_PROMPT], custom: true };
  return { args: [DEFAULT_PROMPT], custom: false };
}

function promptArgsForRun(basePrompt, mode, round, measured) {
  const scenario = WORKLOAD_SCENARIOS[(Math.max(round, 1) - 1) % WORKLOAD_SCENARIOS.length];
  const additions = [
    `Benchmark metadata only: phase=${measured ? "measured" : "warmup"}; mode=${mode}; round=${round}; nonce=${Date.now()}-${Math.random().toString(16).slice(2)}. Do not mention this metadata.`,
  ];
  if (!basePrompt.custom) {
    additions.push(`For this run, ground the memo examples in this scenario: ${scenario}.`);
  }
  return [...basePrompt.args, ...additions];
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
        version: 2,
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

function runPi({ label, cwd, repoRoot, promptArgs, model, provider, thinking, timeoutMs, minOutputChars, progressMs }) {
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
    let firstStdoutMs;
    let firstStderrMs;
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1_000_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    const progressTimer = progressMs > 0
      ? setInterval(() => {
          console.log(`  ... ${label} still running after ${seconds(elapsed())}s`);
        }, progressMs)
      : undefined;
    progressTimer?.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      firstStdoutMs ??= elapsed();
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      firstStderrMs ??= elapsed();
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      const elapsedMs = elapsed();
      const completedMarker = stdout.includes("BENCHMARK_COMPLETE");
      const longEnough = stdout.trim().length >= minOutputChars;
      const result = {
        label,
        elapsedMs,
        firstStdoutMs,
        firstStderrMs,
        generationMs: firstStdoutMs === undefined ? undefined : elapsedMs - firstStdoutMs,
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

function mean(values) {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, pct) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function stats(values) {
  return {
    n: values.length,
    median: median(values),
    mean: mean(values),
    min: values.length ? Math.min(...values) : Number.NaN,
    max: values.length ? Math.max(...values) : Number.NaN,
    p90: percentile(values, 90),
    stddev: stddev(values),
  };
}

function seconds(ms) {
  return Number.isFinite(ms) ? (ms / 1000).toFixed(2) : "n/a";
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
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

function summarizeMetric(results, mode, metric) {
  return stats(results.filter((result) => result.mode === mode).map((result) => result[metric]).filter((value) => typeof value === "number"));
}

function printMetricSummary(label, baseline, tierName, tierStats) {
  const deltaMs = baseline.median - tierStats.median;
  const fasterPct = baseline.median > 0 ? (deltaMs / baseline.median) * 100 : Number.NaN;
  console.log(`${label}:`);
  console.log(`  baseline median=${seconds(baseline.median)}s mean=${seconds(baseline.mean)}s min=${seconds(baseline.min)}s max=${seconds(baseline.max)}s p90=${seconds(baseline.p90)}s σ=${seconds(baseline.stddev)}s`);
  console.log(`  ${tierName} median=${seconds(tierStats.median)}s mean=${seconds(tierStats.mean)}s min=${seconds(tierStats.min)}s max=${seconds(tierStats.max)}s p90=${seconds(tierStats.p90)}s σ=${seconds(tierStats.stddev)}s`);
  console.log(`  median priority-vs-baseline: ${printPriorityDelta(deltaMs)} (${formatPct(Math.abs(fasterPct))})`);
  return { deltaMs, fasterPct };
}

function pairedDeltas(results, tier) {
  const rounds = [...new Set(results.map((result) => result.round))].sort((a, b) => a - b);
  return rounds.flatMap((round) => {
    const baseline = results.find((result) => result.round === round && result.mode === "baseline");
    const tierResult = results.find((result) => result.round === round && result.mode === tier);
    if (!baseline || !tierResult) return [];
    return [{ round, totalMs: baseline.elapsedMs - tierResult.elapsedMs, firstStdoutMs: baseline.firstStdoutMs - tierResult.firstStdoutMs }];
  });
}

function printRunTable(results, tier) {
  console.log("\nMeasured runs");
  console.log("round | mode      | order | first output | total | chars");
  console.log("----- | --------- | ----- | ------------ | ----- | -----");
  for (const result of results) {
    const mode = result.mode === "baseline" ? "off" : tier;
    console.log(
      `${String(result.round).padStart(5)} | ${mode.padEnd(9)} | ${String(result.order).padStart(5)} | ${seconds(result.firstStdoutMs).padStart(12)}s | ${seconds(result.elapsedMs).padStart(5)}s | ${result.stdoutChars}`,
    );
  }
}

function printPriorityDelta(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms === 0) return "tie";
  return `${seconds(Math.abs(ms))}s ${ms > 0 ? "faster" : "slower"}`;
}

function printPairedSummary(results, tier) {
  const deltas = pairedDeltas(results, tier);
  if (deltas.length === 0) return;
  const totalWins = deltas.filter((delta) => delta.totalMs > 0).length;
  const firstOutputWins = deltas.filter((delta) => delta.firstStdoutMs > 0).length;
  console.log("\nPaired deltas by round (relative to baseline; positive is faster for priority)");
  for (const delta of deltas) {
    console.log(`  round ${delta.round}: first output ${printPriorityDelta(delta.firstStdoutMs)}, total ${printPriorityDelta(delta.totalMs)}`);
  }
  console.log(`  wins: first output ${firstOutputWins}/${deltas.length}, total ${totalWins}/${deltas.length}`);
}

function printInterpretation(totalDelta, firstOutputDelta, practicalDeltaMs, practicalDeltaPct) {
  const totalMeaningful = totalDelta.deltaMs >= practicalDeltaMs || totalDelta.fasterPct >= practicalDeltaPct;
  const firstMeaningful = firstOutputDelta.deltaMs >= practicalDeltaMs || firstOutputDelta.fasterPct >= practicalDeltaPct;
  console.log("\nInterpretation");
  if (totalMeaningful || firstMeaningful) {
    console.log(`priority showed a practical improvement by the configured threshold (${seconds(practicalDeltaMs)}s or ${practicalDeltaPct}%).`);
  } else if (totalDelta.deltaMs > 0 || firstOutputDelta.deltaMs > 0) {
    console.log(`priority was directionally faster, but below the configured practical threshold (${seconds(practicalDeltaMs)}s or ${practicalDeltaPct}%).`);
  } else {
    console.log("priority was not faster in this sample. Try more rounds, a busier time window, or a stress profile before drawing a firm conclusion.");
  }
  console.log("Provider-side service tiers often affect queueing and first-token latency more than token generation speed, so compare both first output and total time.");
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const model = process.env.PST_BENCH_MODEL || DEFAULT_MODEL;
  const provider = process.env.PST_BENCH_PROVIDER || "";
  const modelKey = process.env.PST_BENCH_MODEL_KEY || modelKeyFromEnv(model, provider);
  const tier = process.env.PST_BENCH_TIER || DEFAULT_TIER;
  const thinking = process.env.PST_BENCH_THINKING || "medium";
  const rounds = envInt("PST_BENCH_ROUNDS", DEFAULT_ROUNDS);
  const warmups = envInt("PST_BENCH_WARMUPS", DEFAULT_WARMUPS, { min: 0 });
  const timeoutMs = envInt("PST_BENCH_TIMEOUT_MS", 10 * 60 * 1000);
  const minOutputChars = envInt("PST_BENCH_MIN_CHARS", DEFAULT_MIN_OUTPUT_CHARS, { min: 0 });
  const progressMs = envInt("PST_BENCH_PROGRESS_MS", 15_000, { min: 0 });
  const practicalDeltaMs = envInt("PST_BENCH_PRACTICAL_DELTA_MS", DEFAULT_PRACTICAL_DELTA_MS, { min: 0 });
  const practicalDeltaPct = envFloat("PST_BENCH_PRACTICAL_DELTA_PCT", DEFAULT_PRACTICAL_DELTA_PCT, { min: 0 });
  const startMode = startModeFromEnv();
  const basePrompt = promptArgsFromEnv();
  const tmpRoot = mkdtempSync(resolve(tmpdir(), `${PACKAGE_NAME}-bench-`));
  const keepTmp = process.env.PST_BENCH_KEEP_TMP === "1";
  const globalConfig = globalConfigInspection(modelKey);

  const results = [];
  const warmupResults = [];
  try {
    console.log(`Benchmarking ${PACKAGE_NAME}`);
    console.log(`model=${modelKey} cliModel=${model} tier=${tier} thinking=${thinking || "default"} rounds=${rounds} warmups=${warmups} minChars=${minOutputChars} startWith=${startMode}`);
    console.log(`practicalThreshold=${seconds(practicalDeltaMs)}s or ${practicalDeltaPct}% progressEvery=${progressMs === 0 ? "off" : `${seconds(progressMs)}s`}`);
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
    console.log("Running with the extension loaded in both cases; only the project service_tier setting changes.");
    console.log("Each round is paired and the order alternates to reduce time-of-run bias. First-output latency and total latency are both recorded.\n");

    const runCase = async ({ round, mode, measured, order }) => {
      const active = mode !== "baseline";
      writeProjectConfig(tmpRoot, modelKey, active, tier);
      const label = `${measured ? `round ${round}` : `warmup ${round}`} ${active ? tier : "baseline(no service_tier)"}`;
      console.log(`starting ${label}...`);
      const result = await runPi({
        label,
        cwd: tmpRoot,
        repoRoot,
        promptArgs: promptArgsForRun(basePrompt, active ? tier : "baseline", round, measured),
        model,
        provider,
        thinking,
        timeoutMs,
        minOutputChars,
        progressMs,
      });
      const row = { mode: active ? tier : "baseline", round, order, ...result };
      if (measured) results.push(row);
      else warmupResults.push(row);
      console.log(
        `${label}: first=${seconds(result.firstStdoutMs)}s total=${seconds(result.elapsedMs)}s chars=${result.stdoutChars} marker=${result.completedMarker} longEnough=${result.longEnough}`,
      );
    };

    for (let warmup = 1; warmup <= warmups; warmup++) {
      let order = 1;
      for (const mode of orderForRound(warmup, tier, startMode)) await runCase({ round: warmup, mode, measured: false, order: order++ });
      console.log("");
    }

    for (let round = 1; round <= rounds; round++) {
      let order = 1;
      for (const mode of orderForRound(round, tier, startMode)) await runCase({ round, mode, measured: true, order: order++ });
      console.log("");
    }

    const baselineTotal = summarizeMetric(results, "baseline", "elapsedMs");
    const tierTotal = summarizeMetric(results, tier, "elapsedMs");
    const baselineFirst = summarizeMetric(results, "baseline", "firstStdoutMs");
    const tierFirst = summarizeMetric(results, tier, "firstStdoutMs");

    printRunTable(results, tier);
    printPairedSummary(results, tier);
    console.log("\nSummary");
    const firstOutputDelta = printMetricSummary("first output latency", baselineFirst, tier, tierFirst);
    const totalDelta = printMetricSummary("total completion latency", baselineTotal, tier, tierTotal);
    printInterpretation(totalDelta, firstOutputDelta, practicalDeltaMs, practicalDeltaPct);

    console.log("\nRaw JSON:");
    console.log(
      JSON.stringify(
        {
          model: modelKey,
          cliModel: model,
          tier,
          thinking,
          rounds,
          warmups,
          minOutputChars,
          startMode,
          practicalDeltaMs,
          practicalDeltaPct,
          warmupResults,
          results,
          summary: {
            firstOutput: { baseline: baselineFirst, [tier]: tierFirst, ...firstOutputDelta },
            total: { baseline: baselineTotal, [tier]: tierTotal, ...totalDelta },
          },
        },
        null,
        2,
      ),
    );
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
