import type { ReactNode } from 'react';
import type { CapabilityObservation } from './capabilityModel.ts';
import { CAPABILITY_TEXT, checkText, statusText } from './capabilityText.ts';

interface CapabilityListProps {
  observations: readonly CapabilityObservation[];
  /** Additional content shown with one entry, such as media type declarations. */
  extras?: Partial<Record<CapabilityObservation['id'], ReactNode>>;
}

/**
 * Observed capabilities as a description list. Each entry states its status
 * and the individual API checks in text, so nothing depends on color.
 */
export function CapabilityList({ observations, extras = {} }: CapabilityListProps) {
  return (
    <dl className="capability-list">
      {observations.map(({ id, status, checks }) => (
        <div key={id} className="capability">
          <dt className="capability-name">{CAPABILITY_TEXT[id].name}</dt>
          <dd className="capability-status">{statusText(id, status)}</dd>
          <dd className="capability-description">{CAPABILITY_TEXT[id].description}</dd>
          <dd>
            <ul className="capability-checks" aria-label={`${CAPABILITY_TEXT[id].name} checks`}>
              {checks.map((apiCheck) => (
                <li key={apiCheck.api}>
                  <code>{apiCheck.api}</code>: {checkText(id, apiCheck.status)}
                </li>
              ))}
            </ul>
          </dd>
          {extras[id] && <dd>{extras[id]}</dd>}
        </div>
      ))}
    </dl>
  );
}
