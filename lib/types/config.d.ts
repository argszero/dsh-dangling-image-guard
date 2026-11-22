/**
 * The row's configuration: what it defaults to, and what it refuses.
 *
 * @module
 */
/** How the installed listener treats an image whose object is gone. */
export type Mode = 'enforce' | 'observe' | 'off';
/** Every mode this plugin honours. */
export declare const MODES: readonly ["enforce", "observe", "off"];
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
    readonly mode: Mode;
    /** Log each repair, each would-be repair and each scan failure. */
    readonly report: boolean;
}
/**
 * Validate one row's configuration.
 * @param raw - the row's `config`, or nothing.
 * @returns frozen settings.
 * @throws TypeError naming the refused key.
 */
export declare function normalizeConfig(raw?: unknown): Settings;
/** The defaults a loader renders when the row writes no `config`. */
export declare const defaultConfig: Settings;
//# sourceMappingURL=config.d.ts.map