import vm from 'node:vm';

/** The script youtubei.js extracts from YouTube's player (`BuildScriptResult`). */
export interface PlayerScript {
  output: string;
  exported: string[];
}

export type EvalEnv = Record<string, string | number | boolean | null | undefined>;

const EVAL_TIMEOUT_MS = 10_000;

/** Use Node's VM with a deadline so no external JavaScript runtime is required. */
export function evaluatePlayerScript(
  data: PlayerScript,
  env: EvalEnv,
  timeoutMs = EVAL_TIMEOUT_MS,
): Record<string, unknown> {
  const arg = (value: unknown) => JSON.stringify(typeof value === 'string' ? value : '');
  const source =
    `(function () {\n${data.output}\n` +
    `return process(${arg(env.n)}, ${arg(env.sp)}, ${arg(env.sig)});\n})()`;
  const result: unknown = vm.runInNewContext(source, undefined, {
    timeout: timeoutMs,
    filename: 'youtube-player-transform.js',
  });
  if (typeof result !== 'object' || result === null) {
    throw new Error('Player script evaluation returned no result');
  }
  // Copy out of the sandbox realm so callers get plain objects.
  return { ...(result as Record<string, unknown>) };
}
