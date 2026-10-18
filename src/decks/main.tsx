// Monitor 1: the decks interface (Task 3).
// Shantell Sans: hand-drawn feel like the design sketches, still readable as UI.
// "full" includes the informality (INFM) and bounce (BNCE) axes the logo uses.
import '@fontsource-variable/shantell-sans/full.css';
// Rubik: simple type for numbers, lyrics and controls.
import '@fontsource-variable/rubik';
import './theme.css';

import { createRoot } from 'react-dom/client';
import { createStandInEngine } from '../engine/standInEngine';
import { App } from './App';

// This window owns the audio. Swap in the Task 1 engine here when it's ready.
const controller = createStandInEngine();

createRoot(document.getElementById('root')!).render(<App controller={controller} />);
