/**
 * Degrade an image whose stored object is gone, before the adapter reads it.
 *
 * A resumed session can hold an image block whose durable reference no longer
 * resolves to a stored object — the object was collected, the store root moved,
 * or the session was copied without its attachments. The adapter reads that
 * reference for every request it builds, the read throws `ATTACHMENT_NOT_FOUND`,
 * the adapter's catch-all rewraps an `AttachmentError` as `TRANSPORT`, and
 * `TRANSPORT` is retryable. Every retry rebuilds the request from the session and
 * meets the same reference, so the budget is spent and the turn ends on a request
 * that could never have succeeded. That is discussion #14039.
 *
 * The core already degrades one case of this shape: an image the request budget
 * dropped becomes text through `projectOffloadedImages` before any adapter sees
 * it. There is no equivalent branch for an object that is missing, so this plugin
 * supplies it at the same place — in front of the adapter, on the outbound
 * request.
 *
 * The seam is the `llm/stream` waterfall. A loop-built request arrives deep-frozen
 * and `next()` takes no arguments, so the request cannot be edited in place; the
 * replacement is a new options object dispatched back through `ctx.llm.stream()`,
 * with a `WeakSet` identity guard so the listener sees its own replacement once
 * and calls through.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Settings } from './config.ts';
export * from './config.ts';
export * from './guard.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "dangling-image-guard";
/**
 * The model route is a hard requirement: without it there is no request to
 * inspect and no `stream()` to re-dispatch on. The attachment service is not,
 * because a composition that mounts no attachment backend can carry no image
 * reference at all.
 */
export declare const inject: readonly string[];
/** The Cordis name this plugin's read-back view is provided under. */
export declare const SERVICE_NAME = "danglingImageGuard";
/** The properties this plugin is honest about not having. */
export declare const BLIND_SPOTS: readonly string[];
/** What an operator may read back. */
export interface Snapshot {
    /** The resolved mode. */
    readonly mode: Settings['mode'];
    /** Requests re-dispatched with at least one dangling image replaced. */
    readonly repaired: number;
    /** Requests that carried a dangling image that `observe` mode forwarded unchanged. */
    readonly wouldRepair: number;
    /** Image occurrences replaced since mount. */
    readonly imagesReplaced: number;
    /** Image occurrences whose object was present. */
    readonly imagesPresent: number;
    /** Image occurrences the core had already degraded. */
    readonly imagesAlreadyOffloaded: number;
    /** Image occurrences the backend could not answer for. */
    readonly imagesUndecidable: number;
    /** Image occurrences the store refused to place. */
    readonly imagesUnreadable: number;
    /** Scans that threw and were failed open. */
    readonly scanFailures: number;
    /** The properties this plugin does not have, stated where an operator will read it. */
    readonly blindSpots: readonly string[];
}
/** The view this plugin provides under {@link SERVICE_NAME}. */
export interface DanglingImageGuardService {
    /** A point-in-time copy of the counters. */
    snapshot(): Snapshot;
}
/**
 * Mount the plugin.
 *
 * @param ctx - the context this plugin is mounted on.
 * @param config - what the operator wrote.
 */
export declare function apply(ctx: Context, config?: unknown): void;
/** The shape a cordis loader entry loads. */
declare const _default: {
    name: string;
    inject: readonly string[];
    apply: typeof apply;
    defaultConfig: Settings;
};
export default _default;
//# sourceMappingURL=index.d.ts.map