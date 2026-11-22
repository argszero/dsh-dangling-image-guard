/**
 * The predicate and the rewrite, kept free of any harness import.
 *
 * A model request reaches an adapter with image blocks that name durable
 * attachment references. The adapter reads each one through the attachment
 * service, and a backend whose object is gone throws `ATTACHMENT_NOT_FOUND`
 * (`packages/attachment/attachment-local/src/file-store.ts`). That error is an
 * `AttachmentError`, not an `LlmError`, so the adapter's catch-all rewraps it as
 * `TRANSPORT`, which is retryable — and the request is rebuilt from the session
 * for every attempt, so the same reference fails again. The turn ends after the
 * retry budget is spent, which is what #14039 reports.
 *
 * The harness already degrades one case this way: `projectOffloadedImages`
 * replaces an image the request budget dropped with placeholder text before the
 * adapter reads anything. Only the *object is missing* case has no such branch.
 * This module supplies it, using one question the attachment service already
 * answers publicly.
 *
 * @module
 */
/** The fields of a stored image reference this module reads. */
export interface ImageRefLike {
    /** Opaque storage identifier. */
    readonly attachmentId: unknown;
    /** Verified media type, when the reference carries one. */
    readonly mediaType?: unknown;
    /** Encoded byte length, when the reference carries one. */
    readonly bytes?: unknown;
    /** Intrinsic width, when the reference carries one. */
    readonly width?: unknown;
    /** Intrinsic height, when the reference carries one. */
    readonly height?: unknown;
    /** Optional display name. */
    readonly name?: unknown;
}
/** The image content block a request carries. */
export interface ImageBlockLike {
    /** Block discriminator. */
    readonly type: 'image';
    /** The durable reference the adapter would read. */
    readonly attachment: ImageRefLike;
    /** Set by the core's own offload projection; already degraded to text. */
    readonly offloaded?: true;
}
/** The message shape a model request carries. */
export interface MessageLike {
    /** Role the route assigns this message. */
    readonly role?: unknown;
    /** Ordered content blocks. */
    readonly content: readonly unknown[];
}
/**
 * The one attachment-service method this module asks. It is the documented way
 * to locate a provider-owned object on the host filesystem
 * (`packages/attachment/attachment/src/index.ts`), and it returns `undefined`
 * for a backend that is not host-file-backed.
 */
export interface HostPathSource {
    imageHostPath(ref: unknown): string | undefined;
}
/** One image occurrence whose stored object is gone. */
export interface Dangling {
    /** Index of the message holding the block. */
    readonly message: number;
    /** Index of the block inside that message. */
    readonly block: number;
    /** The reference whose object is missing. */
    readonly ref: ImageRefLike;
    /** The host path that was checked and found absent. */
    readonly path: string;
}
/** What one scan found. */
export interface Scan {
    /** Image occurrences whose object is gone, in request order. */
    readonly dangling: readonly Dangling[];
    /** Image occurrences the backend cannot answer for, left untouched. */
    readonly undecidable: number;
    /** Image occurrences the core already degraded, left untouched. */
    readonly alreadyOffloaded: number;
    /** Image occurrences whose object is present. */
    readonly present: number;
    /** Image occurrences refused by the store itself, left untouched. */
    readonly unreadable: number;
}
/**
 * Scan a request for image occurrences whose stored object is missing.
 *
 * The predicate is deliberately narrow. It answers only "the store named a host
 * path for this reference and nothing is at that path". A backend that is not
 * host-file-backed returns `undefined` from `imageHostPath` and is counted as
 * undecidable rather than guessed at, because a wrong guess here would degrade
 * an image that is perfectly readable — a worse outcome than the failure it
 * would be trying to prevent.
 *
 * @param messages - the request's ordered messages; never mutated.
 * @param store - the mounted attachment service.
 * @param exists - filesystem existence probe, injected so the scan stays pure.
 * @returns every occurrence found, with the ones it left alone counted.
 */
export declare function scan(messages: readonly MessageLike[], store: HostPathSource, exists: (path: string) => boolean): Scan;
/**
 * The model-visible replacement for one occurrence whose object is gone.
 *
 * It states three things the model needs to continue rather than retry: that the
 * image is absent, which one it was, and that the bytes are not recoverable in
 * this request. It does not claim the file was deleted — the scan only knows
 * that nothing is at the path the store named.
 *
 * @param ref - the reference whose object is missing.
 * @returns one line of text to send in the image's place.
 */
export declare function placeholder(ref: ImageRefLike): string;
/**
 * Replace every dangling occurrence with its placeholder.
 *
 * Messages and content arrays are copied, never written through: a loop-built
 * request arrives deep-frozen, and mutating one would throw inside the waterfall
 * for a reason unrelated to this guard.
 *
 * @param messages - the request's ordered messages; never mutated.
 * @param dangling - what {@link scan} found.
 * @param text - the replacement builder.
 * @returns a new message array holding no dangling image blocks.
 */
export declare function rewrite(messages: readonly MessageLike[], dangling: readonly Dangling[], text?: (ref: ImageRefLike) => string): readonly MessageLike[];
//# sourceMappingURL=guard.d.ts.map