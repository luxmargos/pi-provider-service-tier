import test from "node:test";
import assert from "node:assert/strict";
import { formatStatus, isStatusFormat, MAX_STATUS_FORMAT_LENGTH, STATUS_FORMAT_TOKENS, STATUS_FORMAT_PRESETS, DEFAULT_STATUS_PRESET, DEFAULT_STATUS_FORMAT } from "./status-format.ts";

const parts = { label: "service_tier", symbol: "⚡", tier: "priority", support: "fallback", fallback: "default" };

test("status templates reorder, repeat and omit segments without evaluating expressions", () => {
  assert.equal(formatStatus(parts, "{symbol} {tier} | {support}"), "⚡ priority | fallback");
  assert.equal(formatStatus(parts, "{support} / {tier} / {tier}"), "fallback / priority / priority");
  assert.equal(formatStatus(parts, "{support} | {fallback}"), "fallback | default");
  assert.equal(formatStatus({ ...parts, fallback: "" }, "{support} | {fallback}"), "fallback | ");
  assert.equal(formatStatus(parts, "{label}"), "service_tier");
  assert.equal(formatStatus(parts, "custom footer"), "custom footer");
});

test("quoted prefixes render only with nonempty sanitized segments", () => {
  const format = '{tier}{" | "support}{" → "fallback}';
  for (const [support, fallback, expected] of [
    ["fallback", "default", "priority | fallback → default"],
    ["manual", "", "priority | manual"],
    ["", "default", "priority → default"],
    ["", "", "priority"],
    ["   ", "\u001b\n\u202e", "priority"],
  ]) {
    assert.ok(isStatusFormat(format));
    assert.equal(formatStatus({ ...parts, support, fallback }, format), expected);
  }
  assert.equal(formatStatus({ ...parts, support: "" }, '{"|"support}'), undefined);
  assert.equal(formatStatus(parts, '{""support}'), "fallback");
  assert.equal(formatStatus({ ...parts, support: "\u001bfallback\n" }, '{" | "support}'), " | fallback");
  assert.equal(formatStatus({ ...parts, support: " ".repeat(128) + "hidden" }, '{" | "support}'), undefined);
  assert.equal(formatStatus({ ...parts, support: "x".repeat(200) }, '{"|"support}')?.length, 129);
  for (const token of STATUS_FORMAT_TOKENS) {
    assert.equal(formatStatus(parts, '{"|"' + token + '}'), "|" + parts[token]);
  }
});

test("quoted prefixes use JSON string escapes and never recursively format text", () => {
  for (const prefix of ['"|": ', "\\ → ", "{tier}", "模式: ", ""]) {
    const format = `{${JSON.stringify(prefix)}support}`;
    assert.ok(isStatusFormat(format));
    assert.equal(formatStatus(parts, format), prefix + "fallback");
    assert.equal(formatStatus({ ...parts, support: "" }, format), undefined);
  }
  assert.equal(formatStatus(parts, '{{" | "support}}'), '{" | "support}');
  assert.equal(formatStatus({ ...parts, support: '{" | "tier}' }, '{" | "support}'), ' | {" | "tier}');
  const bounded = '{"' + "x".repeat(MAX_STATUS_FORMAT_LENGTH - '{""support}'.length) + '"support}';
  assert.equal(bounded.length, MAX_STATUS_FORMAT_LENGTH);
  assert.ok(isStatusFormat(bounded));
  assert.equal(isStatusFormat(bounded + "x"), false);
});

test("malformed quoted prefixes, unknown tokens and decoded controls are invalid", () => {
  for (const value of [
    '{" | "unknown}', '{" | "constructor}', '{" | "__proto__}',
    '{" | "support', '{" | support}', "{' | 'support}", "{|:support}",
    '{"\\q"support}', '{"\\u12"support}', '{"\\"support}', '{" | "{support}}', '{" | " support}',
  ]) {
    assert.equal(isStatusFormat(value), false, value);
    assert.equal(formatStatus(parts, value), formatStatus(parts));
  }
  for (const prefix of ["\n", "\t", "\u001b", "\u009b", "\u2028", "\u2029", "\u202e", "\u2066"]) {
    const format = `{${JSON.stringify(prefix)}support}`;
    assert.equal(isStatusFormat(format), false, format);
    assert.equal(formatStatus(parts, format), formatStatus(parts));
  }
});

test("all footer presets retain the service_tier label in active and off states", () => {
  const off = { ...parts, symbol: "○", tier: "off", support: "", fallback: "" };
  for (const [preset, activeText, offText] of [
    ["minimal", "service_tier: ⚡ priority", "service_tier: ○ off"],
    ["medium", "service_tier: ⚡ priority | fallback", "service_tier: ○ off"],
    ["long", "service_tier: ⚡ priority | fallback → default", "service_tier: ○ off"],
  ] as const) {
    assert.ok(isStatusFormat(STATUS_FORMAT_PRESETS[preset]));
    assert.equal(formatStatus(parts, STATUS_FORMAT_PRESETS[preset]), activeText, preset);
    assert.equal(formatStatus(off, STATUS_FORMAT_PRESETS[preset]), offText, preset);
  }
});

test("omitted or malformed templates use minimal by default; empty templates hide normal status", () => {
  assert.equal(DEFAULT_STATUS_PRESET, "minimal");
  assert.equal(DEFAULT_STATUS_FORMAT, STATUS_FORMAT_PRESETS.minimal);
  assert.equal(formatStatus(parts), "service_tier: ⚡ priority");
  assert.equal(formatStatus(parts, STATUS_FORMAT_PRESETS.minimal), formatStatus(parts));
  assert.equal(formatStatus(parts, STATUS_FORMAT_PRESETS.long), "service_tier: ⚡ priority | fallback → default");
  assert.equal(formatStatus(parts, "{unknown}"), formatStatus(parts));
  assert.equal(formatStatus(parts, ""), undefined);
  assert.equal(formatStatus(parts, "   "), undefined);
});

test("literal braces are escaped and inserted segment values are never recursively formatted", () => {
  assert.ok(isStatusFormat("{{{tier}}}"));
  assert.equal(formatStatus(parts, "{{{tier}}}"), "{priority}");
  assert.equal(formatStatus({ ...parts, support: "{tier}" }, "{support}"), "{tier}");
  assert.equal(formatStatus({ ...parts, fallback: "{tier}" }, "{fallback}"), "{tier}");
});

test("unknown placeholders, unmatched braces, control characters and oversized templates are invalid", () => {
  for (const value of [null, 3, {}, "{unknown}", "{tier", "tier}", "{constructor}", "{__proto__}", "{tier.toUpperCase()}", "\n", "\t", "\u001b[31m", "\u009b31m", "\u2028", "\u202e", "x".repeat(MAX_STATUS_FORMAT_LENGTH + 1)]) {
    assert.equal(isStatusFormat(value), false, JSON.stringify(value));
  }
  assert.equal(isStatusFormat("x".repeat(MAX_STATUS_FORMAT_LENGTH)), true);
  assert.ok(isStatusFormat("{symbol} 模式 {tier}"));
});

test("rendered segment data cannot inject terminal controls and inputs remain unchanged", () => {
  const unsafe = { ...parts, support: "\u001b[31mdefault\n\u202e" };
  const before = structuredClone(unsafe);
  assert.equal(formatStatus(unsafe, "{support}"), "[31mdefault");
  assert.deepEqual(unsafe, before);
  assert.equal(formatStatus({ ...parts, support: "x".repeat(200) }, "{support}")?.length, 128);
  assert.equal(formatStatus({ ...parts, fallback: unsafe.support }, "{fallback}"), "[31mdefault");
});

test("template validation and formatting are deterministic across repeated calls", () => {
  for (let i = 0; i < 4; i++) {
    assert.equal(isStatusFormat("{symbol} {tier}"), true);
    assert.equal(formatStatus(parts, "{symbol} {tier}"), "⚡ priority");
    assert.ok(isStatusFormat('{tier}{" | "support}{" | "fallback}'));
    assert.equal(formatStatus(parts, '{tier}{" | "support}{" | "fallback}'), "priority | fallback | default");
    assert.equal(formatStatus({ ...parts, support: "" }, '{"|"support}'), undefined);
    assert.equal(isStatusFormat("{bad}"), false);
  }
});
