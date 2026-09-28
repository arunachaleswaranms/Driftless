import { useState } from 'react';
import type { MediaTypeDeclaration } from './capabilityModel.ts';
import { browserCapabilityScope, type CapabilityScope } from './capabilityScope.ts';
import { answerText } from './capabilityText.ts';
import { CapabilityList } from './CapabilityList.tsx';
import { detectCapabilities } from './detectCapabilities.ts';

interface CapabilityPanelProps {
  /** The scope to observe. Defaults to the page's own global scope. */
  scope?: CapabilityScope;
}

function MediaTypeDeclarations({
  declarations,
}: {
  declarations: readonly MediaTypeDeclaration[];
}) {
  return (
    <>
      <p className="capability-note">
        <code>canPlayType()</code> answers for container types without codecs. These are the
        browser&apos;s own declarations, not a test, and do not show whether a particular file will
        play.
      </p>
      <ul className="capability-checks" aria-label="Media type declarations">
        {declarations.map(({ mimeType, answer }) => (
          <li key={mimeType}>
            <code>{mimeType}</code>: {answerText(answer)}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A local report of the browser API surfaces this page can observe. It shows
 * runtime observations only: nothing here is a browser support or
 * compatibility claim, and no mode is enabled or disabled from it.
 */
export function CapabilityPanel({ scope }: CapabilityPanelProps) {
  // Detection runs once, when the panel mounts. It only reads properties,
  // so running it again (for example under StrictMode) changes nothing.
  const [report] = useState(() => detectCapabilities(scope ?? browserCapabilityScope()));

  return (
    <section className="panel capabilities" aria-labelledby="capabilities-heading">
      <div>
        <h2 id="capabilities-heading">Browser capabilities</h2>
        <p className="panel-status">
          What this browser exposes, observed on this page. API presence is not browser or product
          support: an API that is present may still not work as Driftless needs. These observations
          stay on this device.
        </p>
      </div>

      <div className="capability-group">
        <h3>Current foundation</h3>
        <p className="capability-note">Used by this build.</p>
        <CapabilityList
          observations={report.foundation}
          extras={{
            'html-video': <MediaTypeDeclarations declarations={report.mediaTypeDeclarations} />,
          }}
        />
      </div>

      <div className="capability-group">
        <h3>Later-phase prerequisites</h3>
        <p className="capability-note">
          Not used by this build. Their presence does not establish that Progressive Watch,
          synchronized watching, or any other later feature will work in this browser.
        </p>
        <CapabilityList observations={report.laterPhase} />
      </div>
    </section>
  );
}
