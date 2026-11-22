/**
 * The row's configuration: what it defaults to, and what it refuses.
 *
 * @module
 */
/** Every mode this plugin honours. */
export const MODES = Object.freeze(['enforce', 'observe', 'off']);
const DEFAULTS = Object.freeze({ mode: 'enforce', report: true });
/**
 * Validate one row's configuration.
 * @param raw - the row's `config`, or nothing.
 * @returns frozen settings.
 * @throws TypeError naming the refused key.
 */
export function normalizeConfig(raw) {
    if (raw === undefined || raw === null)
        return DEFAULTS;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new TypeError('dangling-image-guard: config must be an object');
    }
    const input = raw;
    const mode = input['mode'] ?? DEFAULTS.mode;
    if (typeof mode !== 'string' || !MODES.includes(mode)) {
        throw new TypeError(`dangling-image-guard: mode must be one of ${MODES.join(', ')}`);
    }
    const report = input['report'] ?? DEFAULTS.report;
    if (typeof report !== 'boolean') {
        throw new TypeError('dangling-image-guard: report must be a boolean');
    }
    return Object.freeze({ mode: mode, report });
}
/** The defaults a loader renders when the row writes no `config`. */
export const defaultConfig = DEFAULTS;
