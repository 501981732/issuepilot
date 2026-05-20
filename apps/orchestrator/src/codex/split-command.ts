/**
 * Codex command tokenizer. Lifted verbatim from `daemon.ts` so the V4.6
 * lifecycle adapter can import it without creating a function-level
 * circular dependency through the daemon module (V4.6 follow-up Task 4b).
 *
 * Tokenize a `codex.command` string into `{ command, args[] }`. Supports
 * single + double quoted segments so paths containing spaces survive the
 * trip from the workflow YAML through to `execa`. Without this, an absolute
 * path like `/Users/User Name/.local/bin/codex` would be split into three
 * tokens by the previous `split(/\s+/)` and `execa` would try to spawn
 * `/Users/User`.
 *
 * Rules (intentionally a subset of POSIX shell):
 *   - Whitespace separates tokens.
 *   - `"…"` and `'…'` create a single token; the surrounding quotes are
 *     stripped. Escapes are NOT honoured inside quotes — keep paths simple.
 *   - Unbalanced quotes throw, matching the bash behaviour of refusing to
 *     execute the line.
 */
export function splitCommand(command: string): {
  command: string;
  args: string[];
} {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new Error(
      `codex.command has an unbalanced ${quote} quote: ${command}`,
    );
  }
  if (inToken) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const [cmd, ...args] = tokens;
  return { command: cmd!, args };
}
