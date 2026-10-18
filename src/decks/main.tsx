// Monitor 1: the decks interface (Task 3).
// Shantell Sans: hand-drawn feel like the design sketches, still readable as UI.
// "full" includes the informality (INFM) and bounce (BNCE) axes the logo uses.
import '@fontsource-variable/shantell-sans/full.css';
// Rubik: simple type for numbers, lyrics and controls.
import '@fontsource-variable/rubik';
import './theme.css';

import { createRoot } from 'react-dom/client';
import { AudioEngine } from '../audio/AudioEngine';
import { EngineStore } from './engineStore';
import { App } from './App';

// This window owns the audio engine (Task 1). Exactly one window may construct it.
const engine = new EngineStore(new AudioEngine());

createRoot(document.getElementById('root')!).render(<App engine={engine} />);
