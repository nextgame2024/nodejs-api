export type AvatarProviderName = "simli" | "liveavatar";
export type AvatarProviderSelection = "none" | AvatarProviderName;
export type AvatarSessionMode = "LITE" | "FULL";

export type AvatarProviderSessionRequest = {
  customerId: string;
  deviceId?: string;
  avatarId?: string;
  mode?: AvatarSessionMode;
};

export type AvatarProviderSession = {
  provider: string;
  avatarSessionId: string;
  sessionToken?: string;
  transportMode?: "livekit" | "p2p";
  mode?: AvatarSessionMode;
  streamUrl?: string;
  expiresAt?: string;
};

export interface AvatarProvider {
  readonly providerName: AvatarProviderName;
  createAvatarSession(
    request: AvatarProviderSessionRequest,
  ): Promise<AvatarProviderSession>;
  sendAudioChunk(sessionId: string, audioChunk: Buffer): Promise<void>;
  getVideoStream(sessionId: string): Promise<{ streamUrl?: string }>;
  closeAvatarSession(sessionId: string): Promise<void>;
}
