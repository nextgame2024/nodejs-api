import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { ProviderSessionAdapter, PublicExperience, StoredProviderSession } from "./provider-session.interface.js";
import type { SessionPlan } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";

export const PROVIDER_SESSION_ADAPTERS = Symbol("PROVIDER_SESSION_ADAPTERS");

@Injectable()
export class ProviderSessionRegistry {
  private readonly byKey: ReadonlyMap<string, ProviderSessionAdapter>;
  private readonly byExperience: ReadonlyMap<PublicExperience, ProviderSessionAdapter>;

  constructor(@Inject(PROVIDER_SESSION_ADAPTERS) adapters: readonly ProviderSessionAdapter[]) {
    this.byKey = uniqueMap(adapters.map((adapter) => [adapter.adapterKey, adapter] as const), "session adapter keys");
    this.byExperience = uniqueMap(
      adapters.flatMap((adapter) => adapter.experiences.map((experience) => [experience, adapter] as const)),
      "experience registrations",
    );
  }

  resolveExperience(experience: PublicExperience): ProviderSessionAdapter {
    const adapter = this.byExperience.get(experience);
    if (!adapter) throw new BadRequestException(`Unsupported experience: ${experience}`);
    return adapter;
  }

  resolvePlan(plan: SessionPlan): ProviderSessionAdapter {
    const nativeOwner = plan.capabilityOwners["native-realtime"];
    const owner = plan.providerBindings.find((binding) => binding.bindingId === nativeOwner);
    if (!owner) throw new BadRequestException("The session plan has no native realtime owner.");
    const adapter = [...this.byKey.values()].find((candidate) =>
      candidate.providerAdapterKeys.includes(owner.adapterKey),
    );
    if (!adapter) throw new BadRequestException(`Unsupported session adapter composition: ${owner.adapterKey}`);
    return adapter;
  }

  resolveStoredSession(session: StoredProviderSession): ProviderSessionAdapter {
    const configured = session.metadata.lifecycleAdapterKey;
    if (typeof configured === "string") {
      const adapter = this.byKey.get(configured);
      if (!adapter) throw new BadRequestException(`Unsupported session lifecycle adapter: ${configured}`);
      return adapter;
    }
    // Bounded v1 compatibility for sessions created before lifecycleAdapterKey was persisted.
    return session.aiProvider === "tavus-full"
      ? this.requireKey("composite-realtime-experience-v1")
      : this.requireKey("native-realtime-experience-v1");
  }

  private requireKey(key: string): ProviderSessionAdapter {
    const adapter = this.byKey.get(key);
    if (!adapter) throw new BadRequestException(`Unsupported session lifecycle adapter: ${key}`);
    return adapter;
  }
}

function uniqueMap<K, V>(entries: ReadonlyArray<readonly [K, V]>, label: string): ReadonlyMap<K, V> {
  const map = new Map<K, V>();
  for (const [key, value] of entries) {
    if (map.has(key)) throw new Error(`Provider ${label} must be unique.`);
    map.set(key, value);
  }
  return map;
}
