export const STATUS_FORMAT_TOKENS = ["label", "symbol", "tier", "support", "fallback"] as const;
export const MAX_STATUS_FORMAT_LENGTH = 256;

export const STATUS_FORMAT_PRESETS = {
  minimal: "{label}: {symbol} {tier}",
  medium: '{label}: {symbol} {tier}{" | "support}',
  long: '{label}: {symbol} {tier}{" | "support}{" → "fallback}',
} as const;
export const DEFAULT_STATUS_PRESET = "minimal";
export const DEFAULT_STATUS_FORMAT = STATUS_FORMAT_PRESETS[DEFAULT_STATUS_PRESET];

export interface StatusSegments {
  label: string;
  symbol: string;
  tier: string;
  support: string;
  fallback: string;
}

const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u;
const FORMAT_PART = /\{\{|\}\}|\{("(?:[^"\\]|\\.)*")?(label|symbol|tier|support|fallback)\}/g;
type FormatPart = string | { token: keyof StatusSegments; prefix?: string };

// Share the bounded grammar between config validation and rendering; never evaluate expressions.
function parseStatusFormat(value: unknown): FormatPart[] | undefined {
  if (typeof value !== "string" || value.length > MAX_STATUS_FORMAT_LENGTH || CONTROL.test(value)) return undefined;
  const parts: FormatPart[] = [];
  let offset = 0;
  for (const match of value.matchAll(FORMAT_PART)) {
    const literal = value.slice(offset, match.index);
    if (/[{}]/.test(literal)) return undefined;
    parts.push(literal);
    if (match[0] === "{{") parts.push("{");
    else if (match[0] === "}}") parts.push("}");
    else {
      let prefix: string | undefined;
      if (match[1] !== undefined) {
        try { prefix = JSON.parse(match[1]) as string; }
        catch { return undefined; }
        // JSON escapes must not smuggle controls past the raw-template check.
        if (CONTROL.test(prefix)) return undefined;
      }
      parts.push({ token: match[2] as keyof StatusSegments, prefix });
    }
    offset = match.index + match[0].length;
  }
  const tail = value.slice(offset);
  if (/[{}]/.test(tail)) return undefined;
  parts.push(tail);
  return parts;
}

export function isStatusFormat(value: unknown): value is string {
  return parseStatusFormat(value) !== undefined;
}

export function formatStatus(segments: StatusSegments, format?: string): string | undefined {
  const parts = parseStatusFormat(format ?? DEFAULT_STATUS_FORMAT) ?? parseStatusFormat(DEFAULT_STATUS_FORMAT)!;
  const text = parts.map(part => {
    if (typeof part === "string") return part;
    const value = segments[part.token].replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu, "").slice(0, 128);
    return part.prefix === undefined ? value : value.trim() ? part.prefix + value : "";
  }).join("");
  return text.trim() ? text : undefined;
}
