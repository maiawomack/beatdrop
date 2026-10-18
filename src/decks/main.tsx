// Monitor 1: the decks interface (Task 3).
// Shantell Sans: hand-drawn feel like the design sketches, still readable as UI.
// "full" includes the informality (INFM) and bounce (BNCE) axes the logo uses.
import '@fontsource-variable/shantell-sans/full.css';
// Rubik: simple type for numbers, lyrics and controls.
import '@fontsource-variable/rubik';
import './theme.css';
import './swirl.css'; // experiment: swirling background (delete this line to undo)

import { createRoot } from 'react-dom/client';
import { AudioEngine } from '../audio/AudioEngine';
import { hostEngine } from '../integration/engineSync';
import { EngineStore } from './engineStore';
import { App } from './App';

// This window owns the audio engine (Task 1). Exactly one window may construct it.
const audio = new AudioEngine();
// Share it with the spatial workstation (Monitor 2), which mirrors it instead of playing its own.
hostEngine(audio);
const engine = new EngineStore(audio);

createRoot(document.getElementById('root')!).render(<App engine={engine} />);
