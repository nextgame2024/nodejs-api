export type AvatarProviderSessionRequest = {
  customerId: string;
  deviceId?: string;
  avatarId?: string;
};

export type AvatarProviderSession = {
  provider: string;
  avatarSessionId: string;
  streamUrl?: string;
  expiresAt?: string;
};

export interface AvatarProvider {
  createAvatarSession(
    request: AvatarProviderSessionRequest,
  ): Promise<AvatarProviderSession>;
  sendAudioChunk(sessionId: string, audioChunk: Buffer): Promise<void>;
  getVideoStream(sessionId: string): Promise<{ streamUrl?: string }>;
  closeAvatarSession(sessionId: string): Promise<void>;
}
