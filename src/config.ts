/**
 * The row's configuration: what it defaults to, and what it refuses.
 *
 * @module
 */

/** How the installed listener treats an image whose object is gone. */
export type Mode = 'enforce' | 'observe' | 'off'

/** Every mode this plugin honours. */
export const MODES = Object.freeze(['enforce', 'observe', 'off'] as const satisfies readonly Mode[])

/** Validated settings a mount runs with. */
export interface Settings {
  /**
   * `enforce` (default) replaces a dangling image with placeholder text before
   * the adapter reads it, so the request carries no reference the store cannot
   * resolve and the turn continues.
   * `observe` scans and counts what it would have replaced, but every request is
   * forwarded unchanged — the shape to mount first on a deployment whose
   * behaviour you do not want to change yet.
   * `off` installs no listener.
   */
  readonly mode: Mode
  /** Log each repair, each would-be repair and each scan failure. */
  readonly report: boolean
}

const DEFAULTS: Settings = Object.freeze({ mode: 'enforce', report: true })

/**
 * Validate one row's configuration.
 * @param raw - the row's `config`, or nothing.
 * @returns frozen settings.
 * @throws TypeError naming the refused key.
 */
export function normalizeConfig(raw?: unknown): Settings {
  if (raw === undefined || raw === null) return DEFAULTS
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dangling-image-guard: config must be an object')
  }
  const input = raw as Record<string, unknown>

  const mode = input['mode'] ?? DEFAULTS.mode
  if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
    throw new TypeError(`dangling-image-guard: mode must be one of ${MODES.join(', ')}`)
  }

  const report = input['report'] ?? DEFAULTS.report
  if (typeof report !== 'boolean') {
    throw new TypeError('dangling-image-guard: report must be a boolean')
  }

  return Object.freeze({ mode: mode as Mode, report })
}

/** The defaults a loader renders when the row writes no `config`. */
export const defaultConfig: Settings = DEFAULTS
