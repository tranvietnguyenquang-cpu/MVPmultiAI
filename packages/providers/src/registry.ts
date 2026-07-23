import { ClaudeCliProvider } from "./claude-cli-provider.js";
import { CodexCliProvider } from "./codex-cli-provider.js";
import type { CodingProvider, ProviderId } from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, CodingProvider>();

  constructor(providers: CodingProvider[] = [new CodexCliProvider(), new ClaudeCliProvider()]) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }
  }

  get(id: string): CodingProvider {
    const provider = this.providers.get(id as ProviderId);
    if (!provider) {
      throw new Error(`Unknown provider '${id}'.`);
    }
    return provider;
  }

  list(): CodingProvider[] {
    return [...this.providers.values()];
  }
}
