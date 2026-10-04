import { useEffect, useRef, type SyntheticEvent } from 'react';
import type { MediaMetadata } from './localMediaState.ts';
import { classifyMediaError, type LocalMediaErrorKind } from './mediaError.ts';

interface LocalMediaPlayerProps {
  file: File;
  hidden: boolean;
  onMetadataLoaded: (metadata: MediaMetadata) => void;
  onDurationChanged: (duration: number) => void;
  onFailed: (error: LocalMediaErrorKind) => void;
}

/**
 * A native video element playing one local file through an object URL. This
 * player performs no application-level file read; the browser media stack
 * decodes on demand. Local Sync separately reads bounded identity chunks.
 *
 * Mount one instance per selection (keyed by selection id). The instance owns
 * its object URL from creation to revocation, so a replacement or clear always
 * detaches and releases the previous file before anything else can use the
 * element, and a previous file's element can never deliver events to the next.
 */
export function LocalMediaPlayer({
  file,
  hidden,
  onMetadataLoaded,
  onDurationChanged,
  onFailed,
}: LocalMediaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    return () => {
      // Detach before revoking so the element never refers to a revoked URL.
      // Loading an element without a source stops playback and discards its
      // media resource.
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  function handleLoadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    onMetadataLoaded({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }

  function handleDurationChange(event: SyntheticEvent<HTMLVideoElement>) {
    onDurationChanged(event.currentTarget.duration);
  }

  function handleError(event: SyntheticEvent<HTMLVideoElement>) {
    onFailed(classifyMediaError(event.currentTarget.error));
  }

  return (
    <video
      ref={videoRef}
      className="local-media-video"
      aria-label="Video player"
      controls
      playsInline
      preload="metadata"
      hidden={hidden}
      onLoadedMetadata={handleLoadedMetadata}
      onDurationChange={handleDurationChange}
      onError={handleError}
    />
  );
}
