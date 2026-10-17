export interface CameraOptions {
  width?: number;
  height?: number;
  frameRate?: number;
}

/**
 * Start the user-facing webcam and attach it to the given <video> element.
 * Resolves once the first frame's dimensions are known.
 */
export async function startCamera(
  video: HTMLVideoElement,
  { width = 1280, height = 720, frameRate = 30 }: CameraOptions = {},
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable (needs https or localhost).');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: frameRate },
    },
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await new Promise<void>((resolve) => {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
    else video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}
