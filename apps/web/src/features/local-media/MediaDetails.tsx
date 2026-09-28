import { formatByteSize, formatDimensions, formatDuration } from './format.ts';
import type { LocalMediaSelection } from './localMediaState.ts';

interface MediaDetailsProps {
  selection: LocalMediaSelection;
}

/**
 * Describes the selected file as the browser reports it. The browser-reported
 * type is usually inferred from the file name and does not show whether the
 * file will play. The file's location on the device is never available to
 * the page.
 */
export function MediaDetails({ selection }: MediaDetailsProps) {
  const { file, metadata, status } = selection;

  const pending = status === 'error' ? 'Unavailable' : 'Loading…';
  const duration = metadata
    ? (formatDuration(metadata.duration) ?? 'Not reported by the browser')
    : pending;
  const dimensions = metadata
    ? (formatDimensions(metadata.width, metadata.height) ?? 'Not reported by the browser')
    : pending;

  return (
    <div className="local-media-details">
      <h3>Selected file</h3>
      <dl>
        <div>
          <dt>Name</dt>
          <dd className="local-media-file-name">{file.name}</dd>
        </div>
        <div>
          <dt>Browser-reported type</dt>
          <dd>{file.type || 'Not reported'}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatByteSize(file.size)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>Video dimensions</dt>
          <dd>{dimensions}</dd>
        </div>
      </dl>
    </div>
  );
}
