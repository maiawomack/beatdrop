import type { AudioCommand, AudioCommandSink, StemId } from './AudioCommands';

export interface MockStemState {
  pan: number;
  volume: number;
  grabbed: boolean;
}

/** Stand-in for the real audio engine: records state and logs commands. */
export class MockAudioEngine implements AudioCommandSink {
  readonly stems = new Map<StemId, MockStemState>();

  dispatch(command: AudioCommand): void {
    const stem = this.stems.get(command.stemId) ?? { pan: 0, volume: 1, grabbed: false };
    this.stems.set(command.stemId, stem);

    switch (command.type) {
      case 'grab':
        stem.grabbed = true;
        console.log(`[audio] grab ${command.stemId}`);
        break;
      case 'release':
        stem.grabbed = false;
        console.log(`[audio] release ${command.stemId}`, { pan: stem.pan, volume: stem.volume });
        break;
      case 'setPan':
        stem.pan = command.value;
        break;
      case 'setVolume':
        stem.volume = command.value;
        break;
    }
  }
}
