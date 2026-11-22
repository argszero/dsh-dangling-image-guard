# @argszero/dsh-dangling-image-guard

A DeepSeek Harness plugin that turns one dead image reference from a dead turn into placeholder text.

**The failure it answers.** A session can hold an image block whose durable attachment reference no longer resolves to a stored object — the object was collected, the store root moved, or the session was copied without its attachments. On every request the adapter reads that reference:

1. `attachments.readImageRequest(ref, …)` throws `AttachmentError('…', 'ATTACHMENT_NOT_FOUND')`.
2. `AttachmentError` is not an `LlmError`, so the DeepSeek adapter's catch-all rewraps it as `LlmError(…, 'TRANSPORT', { cause })`.
3. `TRANSPORT` is in `DEFAULT_RETRYABLE_CODES`, so the call is retried five times.
4. Every retry rebuilds the request from the session, so every retry meets the same reference, and the turn ends on a request that could never have succeeded.

The core already degrades one case of this shape: an image the request budget dropped becomes text through `projectOffloadedImages`, before any adapter reads it. There is no equivalent branch for an object that is missing.

**What it does.** It listens on the `llm/stream` waterfall, asks the attachment service for the host path of every image the request carries, and replaces the occurrences whose object is absent with one line of text. The rewrite is dispatched back through `ctx.llm.stream()` with a `WeakSet` identity guard, because a loop-built request arrives deep-frozen and `next()` takes no arguments — the request cannot be edited in place.

The adapter then reads no reference the store cannot resolve, and the turn continues with the model told which image is gone.

## Install

The git channel is the only channel today — this package is **not published to npm** yet:

```sh
dsh plugin add github:argszero/dsh-dangling-image-guard#v0.1.0
```

The bundle row mounts itself; no further configuration is needed.

## Configuration

```yml
- insert:
    - id: dangling-image-guard
      name: '@argszero/dsh-dangling-image-guard'
      config:
        mode: enforce   # enforce | observe | off
        report: true
```

- **`enforce`** (default) replaces a dangling image with placeholder text.
- **`observe`** scans and counts what it *would* replace, and forwards every request unchanged. Mount this first on a deployment whose behaviour you do not want to change yet.
- **`off`** installs no listener.

## What it does not cover

Stated here rather than discovered later:

- **Images only.** A verbatim file attachment whose object is gone is read on a different path and is not covered.
- **Host-file-backed backends only.** A backend that is not host-file-backed answers `undefined` from `imageHostPath`; those occurrences are counted as undecidable and left untouched, because guessing would degrade a readable image.
- **A race remains.** An image that goes missing between the scan and the adapter read still fails the request.
- **Re-dispatch resolves the adapter again**, so a dispatch prepared ahead of the waterfall is not carried across.
- **The session log is not rewritten.** The dangling reference stays in the durable record; this plugin repairs the request.

## Read-back

The plugin provides `danglingImageGuard`, whose `snapshot()` reports `repaired`, `wouldRepair`, `imagesReplaced`, `imagesPresent`, `imagesAlreadyOffloaded`, `imagesUndecidable`, `imagesUnreadable`, `scanFailures` and its `blindSpots`.

## Measured where

25 tests, `node --test`, all passing. Two directions are measured, not asserted:

- **The failure is real on the shipped backend.** A real normalized object written by `dsh-attachment-local`, deleted from disk, makes both `readImage` and `readImageRequest` reject with code `ATTACHMENT_NOT_FOUND` and class `AttachmentError` — not `LlmError`.
- **The change is what fixes it.** With the listener removed, 6 of the 9 hosting tests fail, the headline one with `'image' !== 'text'`: *the adapter never sees an image block it cannot read*. The baseline test — *without the plugin the adapter is handed the dangling reference* — passes in both trees, because it measures the core rather than this plugin.

The hosting tests run a real `LlmRuntime` under the project's own `mountAgentLoopTestDependencies`, with a real attachment backend; the only double is the adapter, which must be, since no provider may be contacted from a test.

**Line measured: `0.2.2-rc.5`.** The `0.2.3-alpha.1` line cannot be measured here, and not because of this plugin: its `dsh-typert-protocol` calls `ctx[Context.root]`, the vendored cordis source at that tag defines `Context.root`, and the **published** `@deepseek-ai/cordis@4.1.0` has no such symbol — so constructing `LlmRuntime` on that line throws `cannot get property "undefined" without inject` before any request exists. That is the same shape as the alpha.1 CLI startup failure reported as #14044: source changed, version never bumped. This guard will be re-measured on that line when it boots.

## Licence

MIT.
