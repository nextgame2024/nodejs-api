import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { ProviderCapabilityManifest } from "../../platform/contracts/v2/sophia-runtime-v2.contracts.js";

export const PROVIDER_ADAPTER_REGISTRATIONS = Symbol("PROVIDER_ADAPTER_REGISTRATIONS");

export type ProviderAdapterRegistration = {
  adapterKey: string;
  manifest: ProviderCapabilityManifest;
  implementation: object;
};

export type ProviderComposition = {
  pipelineMode: ProviderCapabilityManifest["supportedModes"][number];
  bindings: Array<{ bindingId: string; adapterKey: string; capability: string }>;
  capabilityOwners: Record<string, string>;
  audioOutputOwnerBindingId?: string;
};

@Injectable()
export class ProviderCapabilityRegistry {
  private readonly adapters: ReadonlyMap<string, ProviderAdapterRegistration>;

  constructor(
    @Inject(PROVIDER_ADAPTER_REGISTRATIONS)
    registrations: readonly ProviderAdapterRegistration[],
  ) {
    const entries = registrations.map((registration) => [registration.adapterKey, registration] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("Provider adapter keys must be unique.");
    }
    this.adapters = new Map(entries);
  }

  list(): ProviderAdapterRegistration[] {
    return [...this.adapters.values()];
  }

  resolve<T extends object = object>(adapterKey: string, capability: string): ProviderAdapterRegistration & { implementation: T } {
    const registration = this.adapters.get(adapterKey);
    if (!registration) throw new BadRequestException(`Unsupported provider adapter: ${adapterKey}`);
    if (!registration.manifest.capabilities.includes(capability)) {
      throw new BadRequestException(`Provider adapter ${adapterKey} does not support ${capability}.`);
    }
    return registration as ProviderAdapterRegistration & { implementation: T };
  }

  validateComposition(composition: ProviderComposition): ProviderComposition {
    const byBinding = new Map(composition.bindings.map((binding) => [binding.bindingId, binding]));
    if (byBinding.size !== composition.bindings.length) throw new Error("Provider binding IDs must be unique.");

    for (const binding of composition.bindings) {
      const registration = this.resolve(binding.adapterKey, binding.capability);
      if (!registration.manifest.supportedModes.includes(composition.pipelineMode)) {
        throw new Error(`${binding.adapterKey} does not support ${composition.pipelineMode}.`);
      }
    }
    for (const [capability, bindingId] of Object.entries(composition.capabilityOwners)) {
      const binding = byBinding.get(bindingId);
      if (!binding || binding.capability !== capability) {
        throw new Error(`Capability ${capability} has no matching provider owner.`);
      }
    }

    const speechOwners = composition.bindings.filter((binding) => binding.capability === "speech-output");
    if (speechOwners.length > 1 && !composition.audioOutputOwnerBindingId) {
      throw new Error("A composition with multiple speech outputs must declare one audio output owner.");
    }
    if (composition.audioOutputOwnerBindingId && !speechOwners.some(
      (binding) => binding.bindingId === composition.audioOutputOwnerBindingId,
    )) {
      throw new Error("The audio output owner must reference a speech-output binding.");
    }

    if (composition.pipelineMode === "composite-realtime") {
      const nativeBindingId = composition.capabilityOwners["native-realtime"];
      const reasoningBindingId = composition.capabilityOwners.reasoning;
      if (nativeBindingId && reasoningBindingId && nativeBindingId !== reasoningBindingId) {
        const nativeBinding = byBinding.get(nativeBindingId);
        const nativeAdapter = nativeBinding ? this.resolve(nativeBinding.adapterKey, nativeBinding.capability) : undefined;
        if (nativeAdapter?.manifest.reasoningIsReplaceable !== true) {
          throw new Error("This composite provider does not permit a reasoning override.");
        }
      }
    }
    return composition;
  }
}
