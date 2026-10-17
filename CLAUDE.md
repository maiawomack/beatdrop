Update the root-level CLAUDE.md for our shared DubHacks 2026 repository, BeatDrop. Read the existing repository structure and any existing CLAUDE.md before editing. Preserve useful existing instructions.

BeatDrop is a two-monitor, webcam-based, gesture-controlled live DJ and remixing workstation. It is designed to let users mix existing songs without a physical DJ controller or mouse during performance.

**Core architecture**

- Monitor 1: Traditional DJ workstation with two decks, waveforms, track loading, BPM, playback, crossfader, EQ, effects, and stem controls.
- Monitor 2: Spatial AR workstation with a mirrored webcam feed, two-hand tracking, and interactive holographic audio objects representing stems and other music controls.
- Both monitors are DJ-facing, functional interfaces. Neither is an audience view.
- Both interfaces control one authoritative audio engine and share synchronized application state.
- Keyboard shortcuts are allowed. Mouse interaction should not be required during a performance.
- Preprocessed audio stems are acceptable for the MVP. Real-time stem separation is a stretch goal.

**Document the following engineering responsibilities clearly:**

1. Audio engine: two-deck playback, gain, crossfading, stems, loops, effects, playback timing, and a command API.
2. Perception: MediaPipe hand tracking, two-hand landmark detection, pinch recognition, smoothing, coordinate normalization, gesture hysteresis, and tracking-loss handling.
3. Traditional DJ UI: two decks, waveforms, BPM, mixer controls, track management, and synchronized playback feedback.
4. Spatial AR UI: mirrored webcam, holographic stem objects, hover/grab/release states, two-handed interaction, spatial controls, and audio-command dispatch.
5. Stem processing: preparing and loading aligned vocal, instrumental, drum, and bass stems for demonstration.
6. Integration: cross-window communication, shared state, end-to-end testing, audio latency, and reliable demo behavior.

Ruhi owns both perception and spatial AR (tasks 2 and 4). Other responsibilities should remain unassigned until confirmed by the team.

**Define shared TypeScript contracts**

Include recommended types for:

- HandState and GestureState
- DeckId and StemId
- AudioCommand
- DeckState and MixerState
- InteractionState
- ApplicationState

Define coordinate conventions, event ownership, and command dispatch rules.

The perception subsystem should output structured hand data rather than directly modifying audio. The spatial interaction layer should determine which object is selected and translate gestures into audio commands.

Audio commands should go through a shared controller. Only one window/process should own the audio engine to prevent duplicate playback.

If the project uses two browser windows, document an appropriate synchronization mechanism such as BroadcastChannel, including initial state synchronization and ownership of the authoritative state.

**Document the MVP interaction**

1. Load two songs with prepared stems.
2. Display the tracks on the traditional workstation.
3. Track both hands on the spatial workstation.
4. Hover over a vocal stem.
5. Pinch to grab it.
6. Move vertically to change its volume.
7. Release to lock the value.
8. Hear the volume change immediately.
9. See the corresponding control update on Monitor 1.

This is the first end-to-end integration milestone.

**Development rules**

- Use the existing repository structure and technologies where possible.
- Do not independently invent incompatible interfaces.
- Keep subsystem boundaries clear.
- Use mock implementations when dependencies are not ready.
- Prefer a reliable 2D/2.5D spatial interaction system over premature 3D complexity.
- Keep the application runnable throughout development.
- Avoid modifying teammates' components without coordination.
- Do not implement unrelated AI agents or sponsor integrations.
- Prioritize functionality, interaction latency, and integration over cosmetic polish.
- Do not make unrelated code changes while updating CLAUDE.md.

**Include a team coordination section**

Document how developers should:
- Work on separate feature branches.
- Agree on shared interfaces before implementing dependent features.
- Communicate API changes.
- Integrate and test frequently.
- Avoid simultaneous conflicting edits.
- Run and test both monitors locally.

Also include a concise architecture diagram in Markdown, an MVP checklist, stretch goals, and instructions for Claude Code agents to inspect existing files before generating code.

Write a complete, clear, practical CLAUDE.md that all teammates can use as the shared source of project context.

For this task, only modify CLAUDE.md. Do not implement features yet.