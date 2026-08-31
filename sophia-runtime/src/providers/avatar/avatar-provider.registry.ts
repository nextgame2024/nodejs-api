import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  AvatarProvider,
  AvatarProviderName,
} from "./avatar-provider.interface.js";
import { LiveAvatarProvider } from "./liveavatar.provider.js";
import { SimliAvatarProvider } from "./simli-avatar.provider.js";

@Injectable()
export class AvatarProviderRegistry {
  private readonly providers: ReadonlyMap<AvatarProviderName, AvatarProvider>;

  constructor(
    simli: SimliAvatarProvider,
    liveAvatar: LiveAvatarProvider,
  ) {
    this.providers = new Map<AvatarProviderName, AvatarProvider>([
      [simli.providerName, simli],
      [liveAvatar.providerName, liveAvatar],
    ]);
  }

  resolve(name: AvatarProviderName): AvatarProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new BadRequestException(`Unsupported avatar provider: ${name}`);
    }
    return provider;
  }
}
