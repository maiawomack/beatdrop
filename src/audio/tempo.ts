/**
 * Tempo + beat-phase estimate for tracks without a stems manifest (full mixes
 * from the library have no BPM). Pure function on decoded audio, so it can be
 * unit tested.
 *
 * Method: onset-strength envelope (positive energy change in ~10 ms hops),
 * autocorrelation over 70–180 BPM (folded into 85–170 to avoid half/double
 * tempo), then the beat phase that lines up best with the onsets. Downbeats
 * (bar starts) are not detected: bars are counted from the first beat.
 */

export interface TempoEstimate {
  bpm: number;
  /** Song position of a beat, seconds. */
  firstBeatSec: number;
  /** 0..1, how strongly periodic the onsets are. */
  confidence: number;
}

const HOP_SEC = 0.01;
/** Analyse at most this much audio (from the start, skipping the first seconds). */
const MAX_ANALYSIS_SEC = 90;

export function estimateTempo(channels: Float32Array[], sampleRate: number): TempoEstimate | null {
  if (channels.length === 0 || channels[0]!.length < sampleRate * 8) return null;
  const hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
  const hopSec = hop / sampleRate;
  const total = channels[0]!.length;
  const skip = Math.min(Math.floor(total * 0.1), Math.floor(sampleRate * 10));
  const end = Math.min(total, skip + Math.floor(sampleRate * MAX_ANALYSIS_SEC));
  const frames = Math.floor((end - skip) / hop);
  if (frames < 400) return null;

  // Energy per hop (mono sum), then half-wave rectified difference = onset strength.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const s0 = skip + f * hop;
    for (const ch of channels) {
      for (let i = s0; i < s0 + hop; i++) e += ch[i]! * ch[i]!;
    }
    energy[f] = Math.log1p(1000 * (e / hop));
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f]! - energy[f - 1]!);
  // Remove the local mean so sustained loudness doesn't dominate.
  const w = 20;
  const centered = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += onset[f]!;
    if (f >= w) acc -= onset[f - w]!;
    centered[f] = Math.max(0, onset[f]! - acc / Math.min(f + 1, w));
  }

  // Autocorrelation over plausible beat periods.
  const minLag = Math.floor(60 / 180 / hopSec);
  const maxLag = Math.ceil(60 / 70 / hopSec);
  let zero = 0;
  for (let f = 0; f < frames; f++) zero += centered[f]! * centered[f]!;
  if (zero <= 0) return null;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += centered[f]! * centered[f - lag]!;
    ac[lag] = s / zero;
  }
  // Score each lag with its multiples (beats line up with bars too), preferring 85–170 BPM.
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = bpm >= 85 && bpm <= 170 ? 1 : 0.7;
    const twice = 2 * lag <= maxLag ? ac[2 * lag]! : 0;
    const score = (ac[lag]! + 0.5 * twice) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  // Refine to a fractional lag with a parabola through the neighbours.
  const a = ac[bestLag - 1] ?? 0;
  const b = ac[bestLag]!;
  const c = ac[bestLag + 1] ?? 0;
  const denom = a - 2 * b + c;
  const lag = denom < 0 ? bestLag + (0.5 * (a - c)) / denom : bestLag;
  let bpm = 60 / (lag * hopSec);
  while (bpm < 85) bpm *= 2;
  while (bpm > 170) bpm /= 2;
  // Fine-tune tempo and phase together: a tempo off by a fraction of a BPM
  // drifts the comb out of phase over the analysis window.
  let bestPhase = 0;
  let bestSum = -1;
  let bestBpm = bpm;
  for (let k = -30; k <= 30; k++) {
    const cand = bpm * (1 + k * 0.0005);
    const period = 60 / cand / hopSec; // frames per beat
    const steps = Math.ceil(period);
    for (let p = 0; p < steps; p++) {
      let sum = 0;
      for (let t = p; t < frames; t += period) {
        const i = Math.round(t);
        // Allow one hop of slop either side.
        sum += Math.max(centered[i] ?? 0, 0.6 * (centered[i - 1] ?? 0), 0.6 * (centered[i + 1] ?? 0));
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestPhase = p;
        bestBpm = cand;
      }
    }
  }
  bpm = bestBpm;
  const beatSec = 60 / bpm;
  const phaseSec = skip / sampleRate + bestPhase * hopSec;
  const firstBeatSec = ((phaseSec % beatSec) + beatSec) % beatSec;
  return { bpm: Math.round(bpm * 100) / 100, firstBeatSec, confidence: Math.max(0, Math.min(1, b)) };
}
