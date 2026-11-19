import { test, expect, jest } from '@jest/globals';

for (const inboundEnabled of [true, false]) {
  test(`messaging lanes remain independent and drain on shutdown (inbound=${inboundEnabled})`, async () => {
    jest.resetModules();
    const previous = { ...process.env };
    Object.assign(process.env, {
      WHATSAPP_REPLY_WORKER_ENABLED: 'true',
      WHATSAPP_INBOUND_WORKER_ENABLED: String(inboundEnabled),
      WHATSAPP_VOICE_ENABLED: 'false',
    });
    const signals = {};
    const once = jest.spyOn(process, 'once').mockImplementation((signal, handler) => {
      signals[signal] = handler;
      return process;
    });
    let releaseGeneration;
    const generation = new Promise(resolve => { releaseGeneration = resolve; });
    const inbound = jest.fn().mockResolvedValue({ processed: true });
    const generate = jest.fn().mockReturnValue(generation);
    let dispatched;
    const dispatchStarted = new Promise(resolve => { dispatched = resolve; });
    const dispatch = jest.fn().mockImplementation(async () => {
      dispatched();
      return { processed: false };
    });
    const end = jest.fn();
    const noop = jest.fn().mockResolvedValue({ processed: false });
    jest.unstable_mockModule('dotenv/config', () => ({}));
    jest.unstable_mockModule('../src/config/db.js', () => ({ default: { end } }));
    jest.unstable_mockModule('../src/services/messaging/channel-profiles.js', () => ({
      channelProfiles: () => [{ id: 'sophia_ai', ready: true }, { id: 'unready', ready: false }],
    }));
    jest.unstable_mockModule('../src/services/messaging/whatsapp-channel.service.js', () => ({ processChannelEvent: inbound }));
    jest.unstable_mockModule('../src/services/messaging/reply-worker.js', () => ({ generateOne: generate, dispatchOne: dispatch, queueFollowUpOne: noop }));
    jest.unstable_mockModule('../src/adapters/whatsapp/outbound.js', () => ({ sendText: noop }));
    jest.unstable_mockModule('../sophia-runtime/dist/providers/reasoning/channel-reasoner.js', () => ({ generateChannelAnswer: noop }));
    jest.unstable_mockModule('../src/services/messaging/voice-worker.js', () => ({ transcribeOne: noop, synthesizeOne: noop, expireVoiceAssets: noop, prepareVoiceMedia: noop }));
    jest.unstable_mockModule('../src/adapters/whatsapp/media.js', () => ({ downloadAudio: noop, uploadAudio: noop }));
    jest.unstable_mockModule('../sophia-runtime/dist/providers/speech/channel-speech.js', () => ({ transcribeChannelAudio: noop, synthesizeChannelAudio: noop }));
    let running;
    try {
      running = import('../scripts/process-whatsapp-replies.mjs');
      await dispatchStarted;
      expect(generate).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(inbound).toHaveBeenCalledTimes(inboundEnabled ? 1 : 0);
      signals.SIGTERM();
      expect(end).not.toHaveBeenCalled();
      releaseGeneration({ processed: true });
      await running;
      expect(end).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
    } finally {
      signals.SIGTERM?.();
      releaseGeneration({ processed: false });
      if (running) await running;
      once.mockRestore();
      process.env = previous;
    }
  });
}
