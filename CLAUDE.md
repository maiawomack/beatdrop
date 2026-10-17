I am responsible for the Perception and Spatial AR subsystems (Tasks 2 and 4).

Read CLAUDE.md first and understand the overall project architecture.

I want to implement a reliable two-handed spatial interaction system using MediaPipe and a mirrored webcam feed.

Start by helping me plan the architecture for:
1. Webcam initialization and rendering.
2. Two-hand tracking and landmark extraction.
3. Pinch detection, gesture state, and smoothing.
4. Normalized coordinate mapping.
5. Interactive holographic audio objects.
6. Independent grabbing and manipulation with both hands.
7. Dispatching audio commands through the shared interface.

Keep the perception pipeline independent from the visual components and audio engine.

First inspect the repository and identify existing code, dependencies, and shared interfaces. Propose a minimal implementation plan before editing files.

Prioritize a working pinch-and-drag interaction with one virtual vocal stem before adding more gestures or advanced visuals.