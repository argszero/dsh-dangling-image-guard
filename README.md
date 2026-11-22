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
dsh plugin add github:argszero/dsh-dangling-image-guard#v0.1.1
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

**Lines measured: `0.2.2-rc.5` and `0.2.3-alpha.2`.** Both arms are green — 25/25 on each, with `@deepseek-ai/cordis` 4.1.0 beside `dsh-llm` 0.2.2-rc.5, and 4.2.0-alpha.1 beside 0.2.3-alpha.2. The reverse arm was run on both: remove the listener registration and the same 6 hosting tests fail, the headline one with `'image' !== 'text'`. No source line changed between the two runs; only the dependency generation did.

`0.2.3-alpha.1` stays unmeasured, and not because of this plugin: it cannot construct `LlmRuntime` at all. Its `dsh-typert-protocol` calls `ctx[Context.root]`, the vendored cordis source at that tag defines it, and the **published** `@deepseek-ai/cordis@4.1.0` has no such symbol — so construction throws `cannot get property "undefined" without inject` before any request exists. That is the "source changed, version never bumped" shape alpha.2 repaired; the install there is described in discussion #14044.

The peer ranges name the measured lines separately rather than spanning them with one comparator:

```
@deepseek-ai/dsh-llm   >=0.2.2-rc.1 <0.2.3 || >=0.2.3-alpha.1 <0.3.0
@deepseek-ai/cordis    ^4.0.2 || >=4.0.5-alpha.1 <5 || >=4.2.0-alpha.1 <5
```

The separate segments are not decoration. A prerelease version satisfies a range only if some comparator in it carries the same `major.minor.patch` tuple with a prerelease of its own, so the single span `>=0.2.2-rc.1 <0.3.0` covers `0.2.2-rc.5` and reads as **unsatisfied** for `0.2.3-alpha.2` — measured with semver 7.8.4, the resolver npm itself bundles. The same rule is why `cordis@4.2.0-alpha.1` needs its own segment.

## Licence

MIT.
