import type { PoTokenProvider, PoTokenRequest } from '../types.js';

/** Accept caller-provided tokens; do not mint them. */
export class PoTokenSource {
  readonly #provider: PoTokenProvider | undefined;
  readonly #staticToken: string | undefined;

  constructor(options: { poTokenProvider?: PoTokenProvider; poToken?: string }) {
    this.#provider = options.poTokenProvider;
    this.#staticToken = options.poToken?.trim() || undefined;
  }

  get configured(): boolean {
    return Boolean(this.#provider || this.#staticToken);
  }

  get staticToken(): string | undefined {
    return this.#staticToken;
  }

  /** Prefer the provider; fall back to the static token if it fails or returns nothing. */
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
