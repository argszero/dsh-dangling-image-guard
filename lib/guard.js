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
/** Is this value an image block this module may consider? */
function isImageBlock(block) {
    if (block === null || typeof block !== 'object')
        return false;
    const candidate = block;
    return candidate.type === 'image'
        && candidate.attachment !== null
        && typeof candidate.attachment === 'object';
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
export function scan(messages, store, exists) {
    const dangling = [];
    let undecidable = 0;
    let alreadyOffloaded = 0;
    let present = 0;
    let unreadable = 0;
    for (const [messageIndex, message] of messages.entries()) {
        const content = message?.content;
        if (!Array.isArray(content))
            continue;
        for (const [blockIndex, block] of content.entries()) {
            if (!isImageBlock(block))
                continue;
            if (block.offloaded === true) {
                alreadyOffloaded += 1;
                continue;
            }
            let path;
            try {
                path = store.imageHostPath(block.attachment);
            }
            catch {
                // The store refused to answer for this reference. That refusal is the
                // store's own verdict about a reference it cannot place, and it is not
                // this module's to reinterpret.
                unreadable += 1;
                continue;
            }
            if (typeof path !== 'string' || path.length === 0) {
                undecidable += 1;
                continue;
            }
            if (exists(path)) {
                present += 1;
                continue;
            }
            dangling.push({ message: messageIndex, block: blockIndex, ref: block.attachment, path });
        }
    }
    return Object.freeze({ dangling, undecidable, alreadyOffloaded, present, unreadable });
}
/** The metadata half of the placeholder, so two images never read alike. */
function describe(ref) {
    const parts = [];
    if (typeof ref.mediaType === 'string' && ref.mediaType.length > 0)
        parts.push(ref.mediaType);
    const width = ref.width;
    const height = ref.height;
    if (typeof width === 'number' && typeof height === 'number')
        parts.push(`${width}\u00d7${height}`);
    if (typeof ref.bytes === 'number')
        parts.push(`${ref.bytes} bytes`);
    const name = typeof ref.name === 'string' && ref.name.length > 0 ? ` "${ref.name}"` : '';
    const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : String(ref.attachmentId);
    const detail = parts.length === 0 ? '' : ` (${parts.join(', ')})`;
    return `attachment ${id}${name}${detail}`;
}
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
export function placeholder(ref) {
    return `[image unavailable: the attachment store has no object for ${describe(ref)}`
        + ' at the path it reported, so it was left out of this request.'
        + ' Ask the user to attach the image again if it is still needed.]';
}
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
export function rewrite(messages, dangling, text = placeholder) {
    const byMessage = new Map();
    for (const found of dangling) {
        let blocks = byMessage.get(found.message);
        if (blocks === undefined) {
            blocks = new Map();
            byMessage.set(found.message, blocks);
        }
        blocks.set(found.block, found.ref);
    }
    return messages.map((message, messageIndex) => {
        const blocks = byMessage.get(messageIndex);
        if (blocks === undefined)
            return message;
        const content = message.content.map((block, blockIndex) => {
            const ref = blocks.get(blockIndex);
            return ref === undefined ? block : { type: 'text', text: text(ref) };
        });
        return { ...message, content };
    });
}
