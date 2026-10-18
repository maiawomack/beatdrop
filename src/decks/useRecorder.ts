import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioController } from '../shared/contracts';

export interface Recorder {
  /** False when the engine can't provide its output (no record button then). */
  available: boolean;
  recording: boolean;
  /** Seconds recorded so far. */
  elapsed: number;
  toggle(): void;
}

// Chrome and Firefox record Opus in WebM; Safari only does MP4/AAC.
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/** Records the master mix and downloads it when recording stops. */
export function useRecorder(controller: AudioController): Recorder {
  const available = typeof MediaRecorder !== 'undefined' && Boolean(controller.getOutputStream);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(id);
  }, [recording]);

  const toggle = useCallback(() => {
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    const stream = controller.getOutputStream?.();
    if (!stream) return;
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 256_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      recorder.current = null;
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType });
      if (!blob.size) return;
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `beatdrop-set-${stamp}.${rec.mimeType.includes('mp4') ? 'm4a' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };
    rec.start(1000);
    recorder.current = rec;
    setRecording(true);
  }, [controller]);

  return { available, recording, elapsed, toggle };
}
