import type { PoTokenProvider, PoTokenRequest } from '../types.js';

//---- Section used for Proof-of-Origin token plumbing ----

/**
 * Resolves PO tokens from user configuration. tubepull deliberately does not mint tokens itself;
 * callers plug in a provider (or a static token + matching visitor data).
 */
export class PoTokenSource {
  readonly #provider: PoTokenProvider | undefined;
  readonly #staticToken: string | undefined;

  constructor(options: { poTokenProvider?: PoTokenProvider; poToken?: string }) {
    this.#provider = options.poTokenProvider;
    this.#staticToken = options.poToken?.trim() || undefined;
  }

  /** True when any token source is configured. */
  get configured(): boolean {
    return Boolean(this.#provider || this.#staticToken);
  }

  /** The session-wide static token, if any. */
  get staticToken(): string | undefined {
    return this.#staticToken;
  }

  /**
   * This function is used for asking the provider for a token for one video, falling back to the
   * static token. Provider failures are reported to `onError` and treated as "no token".
   */
  async forVideo(request: PoTokenRequest, onError: (error: unknown) => void): Promise<string | undefined> {
    if (this.#provider) {
      try {
        const token = await this.#provider(request);
        if (token) return token;
      } catch (error) {
        onError(error);
      }
    }
    return this.#staticToken;
  }
}
