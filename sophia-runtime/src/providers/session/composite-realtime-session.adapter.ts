import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { TavusPartialSessionError, type TavusFullProvider } from "../tavus/tavus-full.provider.js";
import { ProviderCapabilityRegistry } from "../capability/provider-capability.registry.js";
import type {
  ProviderSessionAdapter,
  ProviderSessionOpenRequest,
  ProviderSessionOpenResult,
  StoredProviderSession,
} from "./provider-session.interface.js";
import { ProviderPartialOpenError } from "./provider-session.interface.js";
import { ProviderCatalogGate } from "../provisioning/provider-catalog-gate.js";

@Injectable()
export class CompositeRealtimeSessionAdapter implements ProviderSessionAdapter {
  readonly adapterKey = "composite-realtime-experience-v1";
  readonly providerAdapterKeys = ["composite-realtime-v1"] as const;
  readonly experiences = ["premium"] as const;

  constructor(
    @Inject(ProviderCapabilityRegistry) private readonly providers: ProviderCapabilityRegistry,
    @Inject(ProviderCatalogGate) private readonly catalog: ProviderCatalogGate,
  ) {}

  async open(request: ProviderSessionOpenRequest): Promise<ProviderSessionOpenResult> {
    const deployment = await this.catalog.assertTavusReady(request.customerId);
    const provider = this.providers.resolve<TavusFullProvider>(
      "composite-realtime-v1", "native-realtime",
    ).implementation;
    const tools = request.tools.filter(({ name }) => name !== "researchBusiness" && name !== "research.public");
    const toolDigest = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
    if (deployment.catalogDigest !== toolDigest) {
      throw new Error("The active Tavus catalog does not match this session's canonical/legacy tool catalog.");
    }
    let session;
    try {
      session = await provider.createSession({
        customerId: request.customerId,
        deviceId: request.deviceId,
        storeId: request.storeId,
        tools,
        instructions: request.instructions,
      });
    } catch (error) {
      if (error instanceof TavusPartialSessionError) {
        throw new ProviderPartialOpenError(error.message, {
          aiProvider: "tavus-full",
          avatarProvider: "tavus",
          providerSessionId: error.conversationId,
          avatarSessionId: error.conversationId,
          metadata: {
            lifecycleAdapterKey: this.adapterKey,
            compositeAdapterKey: "composite-realtime-v1",
            providerCatalogDeploymentId: deployment.deploymentId,
            providerCatalogVersion: deployment.catalogVersion,
            experience: request.experience,
          },
        }, { cause: error });
      }
      throw error;
    }
    return {
      persistence: {
        aiProvider: session.provider,
        avatarProvider: "tavus",
        providerSessionId: session.providerSessionId,
        avatarSessionId: session.providerSessionId,
        metadata: {
          lifecycleAdapterKey: this.adapterKey,
          compositeAdapterKey: "composite-realtime-v1",
          model: session.model,
          outputModality: session.outputModality,
          billingPath: "tavus-only",
          openAiSessionCreated: false,
          experience: request.experience,
          providerCatalogDeploymentId: deployment.deploymentId,
          providerCatalogVersion: deployment.catalogVersion,
        },
      },
      ai: { provider: session.provider, model: session.model, outputModality: session.outputModality },
      avatar: {
        provider: "tavus",
        sessionToken: session.meetingToken,
        streamUrl: session.conversationUrl,
      },
      tools,
    };
  }

  async close(session: StoredProviderSession): Promise<void> {
    if (!session.providerSessionId) throw new Error("Composite session is missing its provider session ID.");
    const provider = this.providers.resolve<TavusFullProvider>(
      "composite-realtime-v1", "native-realtime",
    ).implementation;
    await provider.closeSession(session.providerSessionId);
  }
}
