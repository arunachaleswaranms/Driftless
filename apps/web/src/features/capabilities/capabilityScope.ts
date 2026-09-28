/**
 * A global-scope-like object that capability detection reads from: the page's
 * `window` in the browser, or a synthetic object in tests. Detection reads
 * properties only when it runs, never when a module is imported.
 */
export type CapabilityScope = object;

/** The page's own global scope. */
export function browserCapabilityScope(): CapabilityScope {
  return globalThis;
}

/** The result of reading one property path from a scope. */
export type Lookup =
  | { readonly kind: 'found'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked' };

const MISSING: Lookup = { kind: 'missing' };
const BLOCKED: Lookup = { kind: 'blocked' };

function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function lookupKey(current: Lookup, key: string): Lookup {
  if (current.kind !== 'found') {
    return current;
  }
  if (!isObjectLike(current.value)) {
    return MISSING;
  }
  try {
    const value: unknown = Reflect.get(current.value, key);
    return value === undefined || value === null ? MISSING : { kind: 'found', value };
  } catch {
    // Some browsers throw from a getter instead of omitting a blocked API,
    // for example for navigator.serviceWorker when storage is disabled.
    return BLOCKED;
  }
}

/**
 * Reads a property path, such as `['navigator', 'storage', 'getDirectory']`,
 * without calling anything on the way. A missing link reports `missing`; a
 * getter that throws reports `blocked`. It never throws.
 */
export function lookupPath(scope: CapabilityScope, path: readonly string[]): Lookup {
  return path.reduce(lookupKey, { kind: 'found', value: scope });
}
