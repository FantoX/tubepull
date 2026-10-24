import vm from 'node:vm';

//---- Section used for player-script evaluation ----

/** The script youtubei.js extracts from YouTube's player (`BuildScriptResult`). */
export interface PlayerScript {
  output: string;
  exported: string[];
}

export type EvalEnv = Record<string, string | number | boolean | null | undefined>;

const EVAL_TIMEOUT_MS = 10_000;

/**
 * This function is used for running the signature / `n` transform that youtubei.js extracts from the
 * player script. It executes in a fresh `node:vm` context with a timeout, so no external JS runtime
 * (Deno/Bun) is needed. The context has no `require`/`process`; the script only does string maths.
 */
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
