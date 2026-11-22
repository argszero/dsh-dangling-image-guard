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
import { existsSync } from 'node:fs';
import { defaultConfig, normalizeConfig } from "./config.js";
import { rewrite, scan } from "./guard.js";
export * from "./config.js";
export * from "./guard.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dangling-image-guard';
/**
 * The model route is a hard requirement: without it there is no request to
 * inspect and no `stream()` to re-dispatch on. The attachment service is not,
 * because a composition that mounts no attachment backend can carry no image
 * reference at all.
 */
export const inject = ['llm'];
/** The Cordis name this plugin's read-back view is provided under. */
export const SERVICE_NAME = 'danglingImageGuard';
/** The properties this plugin is honest about not having. */
export const BLIND_SPOTS = [
    'Only image occurrences are inspected. A verbatim file attachment whose object is gone is read on a different path and is not covered.',
    'A backend that is not host-file-backed answers `undefined` from `imageHostPath`; those occurrences are counted as undecidable and left untouched, because guessing would degrade a readable image.',
    'The scan sees the request the loop built, not the moment the object disappeared: an image that goes missing between the scan and the adapter read still fails the request.',
    'Re-dispatching resolves the adapter again, so a dispatch prepared ahead of the waterfall is not carried across.',
    'The repaired reference stays in the session log. This plugin repairs the request; it does not rewrite the durable record.',
    'A request that carries no `messages` array — a shape this plugin does not recognise — is forwarded unchanged.',
];
/**
 * Mount the plugin.
 *
 * @param ctx - the context this plugin is mounted on.
 * @param config - what the operator wrote.
 */
export function apply(ctx, config = {}) {
    const settings = normalizeConfig(config);
    const dispatched = new WeakSet();
    let repaired = 0;
    let wouldRepair = 0;
    let imagesReplaced = 0;
    let imagesPresent = 0;
    let imagesAlreadyOffloaded = 0;
    let imagesUndecidable = 0;
    let imagesUnreadable = 0;
    let scanFailures = 0;
    const say = (level, message) => {
        if (!settings.report)
            return;
        if (level === 'warn')
            ctx.logger.warn(`dangling-image-guard: ${message}`);
        else if (level === 'info')
            ctx.logger.info(`dangling-image-guard: ${message}`);
        else
            ctx.logger.debug(`dangling-image-guard: ${message}`);
    };
    const service = {
        snapshot: () => ({
            mode: settings.mode,
            repaired,
            wouldRepair,
            imagesReplaced,
            imagesPresent,
            imagesAlreadyOffloaded,
            imagesUndecidable,
            imagesUnreadable,
            scanFailures,
            blindSpots: BLIND_SPOTS,
        }),
    };
    if (settings.mode === 'off') {
        say('info', 'mode is off: no listener installed');
        ctx.provide(SERVICE_NAME, service);
        return;
    }
    const observe = settings.mode === 'observe';
    /** The mounted attachment service, read per request: the row may mount later. */
    const attachments = () => {
        try {
            const get = ctx.get;
            if (typeof get !== 'function')
                return undefined;
            const store = get.call(ctx, 'attachments');
            if (store === undefined || store === null || typeof store !== 'object')
                return undefined;
            const probe = store.imageHostPath;
            if (typeof probe !== 'function')
                return undefined;
            return {
                imageHostPath: (ref) => {
                    const resolved = probe.call(store, ref);
                    return typeof resolved === 'string' ? resolved : undefined;
                },
            };
        }
        catch {
            // A composition without the service, or a context whose view is not
            // active, has no image references to answer for.
            return undefined;
        }
    };
    const noteScan = (found) => {
        imagesPresent += found.present;
        imagesAlreadyOffloaded += found.alreadyOffloaded;
        imagesUndecidable += found.undecidable;
        imagesUnreadable += found.unreadable;
    };
    const listener = (options, next) => {
        if (options === null || typeof options !== 'object')
            return next();
        // The replacement this listener dispatched comes back through the same
        // waterfall; call through rather than rewriting a second time.
        if (dispatched.has(options))
            return next();
        const messages = options.messages;
        if (!Array.isArray(messages))
            return next();
        const store = attachments();
        if (store === undefined)
            return next();
        let found;
        try {
            found = scan(messages, store, existsSync);
        }
        catch (error) {
            // Fail open: a scan that cannot finish must not turn a working request
            // into a broken one.
            scanFailures += 1;
            say('warn', `scan failed, request forwarded unchanged: ${String(error)}`);
            return next();
        }
        noteScan(found);
        if (found.dangling.length === 0)
            return next();
        if (observe) {
            wouldRepair += 1;
            say('info', `would replace ${found.dangling.length} image occurrence(s) with placeholder text`);
            return next();
        }
        const replacement = {
            ...options,
            messages: rewrite(messages, found.dangling),
        };
        dispatched.add(replacement);
        repaired += 1;
        imagesReplaced += found.dangling.length;
        say('info', `replaced ${found.dangling.length} image occurrence(s) whose object is missing, `
            + 'so the adapter reads no reference the store cannot resolve');
        const llm = ctx.llm;
        return llm.stream(replacement);
    };
    const on = ctx.on.bind(ctx);
    const dispose = on('llm/stream', listener);
    ctx.effect(() => () => {
        dispose();
    }, 'dangling-image-guard: llm/stream listener');
    say('info', `mounted in ${settings.mode} mode`);
    ctx.provide(SERVICE_NAME, service);
}
/** The shape a cordis loader entry loads. */
export default { name, inject, apply, defaultConfig };
