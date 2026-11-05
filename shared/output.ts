import { MAX_OUTPUT_CHARS, type CommandResult } from "./commands.ts";

export function resultMarker(token: string) {
  return `PASEO_RESULT_${token}`;
}

export function boundOutput(output: string) {
  const tail = output.slice(-MAX_OUTPUT_CHARS);
  // Avoid cutting a UTF-16 surrogate pair at the retained tail's first character.
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

export function readCompletion(token: string, capture: { lines: string[]; totalLines: number }): CommandResult | undefined {
  const text = capture.lines.join("\n");
  // A narrow or resized terminal can wrap the marker across several screen lines.
  const marker = resultMarker(token).split("").map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\n?");
  const matches = [...text.matchAll(new RegExp(`(?:^|\\n)${marker}\\n?:\\n?(\\d(?:\\n?\\d){0,2})(?=\\n|$)`, "g"))];
  const match = matches.at(-1);
  if (!match) return;
  const exitCode = Number(match[1].replaceAll("\n", ""));
  if (exitCode > 255) return;
  const output = text.slice(0, match.index);
  return {
    exitCode, output: boundOutput(output), outputStream: "combined",
    truncated: capture.totalLines > capture.lines.length || output.length > MAX_OUTPUT_CHARS,
  };
}
