/**
 * The seam, end to end: a real `LlmRuntime`, the real attachment backend, and a
 * request that really carries a deleted object.
 *
 * The only double is the adapter itself, because no provider may be contacted
 * from a test. It records the messages it was handed, which is exactly the
 * question at issue: does the adapter read the dangling reference, and does it
 * still read it after the plugin replaces it.
 *
 * The `llm/stream` request side is deep-frozen for a loop-built request and
 * `next()` takes no arguments, so the plugin cannot rewrite in place. What this
 * file proves is the substitution path it uses instead: build a new options
 * object and dispatch it back through `ctx.llm.stream()`, with a `WeakSet`
 * identity guard so the listener meets its own replacement once and calls
 * through. Without that guard the listener would re-dispatch forever, so the
 * "runs exactly once" assertions below are the guard's own evidence.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import plugin, { SERVICE_NAME } from '../lib/index.js'

/**
 * Two real PNGs with different bytes. The backend is content-addressed, so two
 * copies of one image share one object and deleting it would dangle both.
 */
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAD0lEQVR4nGNgYPgPQ5gsAH2gCPgfW8MjAAAAAElFTkSuQmCC',
  'base64',
)

/** Records what the adapter was asked to send, then finishes without a network. */
class RecordingAdapter extends LlmAdapter {
  /** Every request this adapter received, in dispatch order. */
  received = []

  async * stream(options) {
    this.received.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Drain a chunk stream so any throw inside it surfaces here. */
async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * The real composition: the project's own prerequisite mounting (which brings the
 * real `LlmRuntime`), the real local attachment backend over a private home, and
 * an adapter that answers locally.
 */
async function harness(config, { mountPlugin = true, before } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dig-host-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['recording'], adapter)
  // A listener mounted here sits upstream of the plugin, so it sees the original
  // request *and* whatever the plugin dispatches in its place.
  if (before !== undefined) before(ctx)
  if (mountPlugin) await ctx.plugin(plugin, config)
  const store = ctx.attachments ?? ctx.get('attachments')
  return { ctx, adapter, store, home }
}

/** One user request carrying the given image references. */
function requestOf(refs) {
  return {
    provider: 'recording',
    model: 'recording-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is in these images?' },
        ...refs.map(attachment => ({ type: 'image', attachment })),
      ],
    }],
  }
}

test('without the plugin the adapter is handed the dangling reference', async () => {
  const { ctx, adapter, store } = await harness({ report: false }, { mountPlugin: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    await drain(ctx.llm.stream(requestOf([gone])))

    assert.equal(adapter.received.length, 1)
    const content = adapter.received[0].messages[0].content
    assert.equal(content[1].type, 'image', 'the baseline: the adapter would try to read it')
    assert.equal(content[1].attachment.attachmentId, gone.attachmentId)
  } finally {
    await ctx.dispose?.()
  }
})

test('with the plugin the adapter is handed placeholder text instead, once', async () => {
  const { ctx, adapter, store } = await harness({ report: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png', name: 'gone.png' })
    rmSync(store.imageHostPath(gone))

    const chunks = await drain(ctx.llm.stream(requestOf([gone])))

    assert.equal(adapter.received.length, 1, 'the re-dispatch reached the adapter exactly once')
    assert.equal(chunks.at(-1).reason.kind, 'stop', 'the request settled normally')

    const content = adapter.received[0].messages[0].content
    assert.equal(content.length, 2, 'the block count is preserved')
    assert.equal(content[0].text, 'what is in these images?')
    assert.equal(content[1].type, 'text', 'the adapter never sees an image block it cannot read')
    assert.match(content[1].text, /image unavailable/)
    assert.match(content[1].text, /gone\.png/)

    const service = ctx.get(SERVICE_NAME)
    assert.equal(service.snapshot().repaired, 1)
    assert.equal(service.snapshot().imagesReplaced, 1)
    assert.equal(service.snapshot().mode, 'enforce')
  } finally {
    await ctx.dispose?.()
  }
})

test('a request whose images are all readable passes through untouched', async () => {
  const { ctx, adapter, store } = await harness({ report: false })
  try {
    const live = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    const request = requestOf([live])

    await drain(ctx.llm.stream(request))

    assert.equal(adapter.received.length, 1)
    const content = adapter.received[0].messages[0].content
    assert.equal(content[1].type, 'image', 'a readable image stays an image')
    assert.equal(content[1].attachment.attachmentId, live.attachmentId)
    const service = ctx.get(SERVICE_NAME)
    assert.equal(service.snapshot().repaired, 0)
    assert.equal(service.snapshot().imagesPresent, 1)
  } finally {
    await ctx.dispose?.()
  }
})

test('one dangling image among healthy neighbours is the only one replaced', async () => {
  const { ctx, adapter, store } = await harness({ report: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    const live = await store.saveImage({ data: PNG_BLUE, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    await drain(ctx.llm.stream(requestOf([gone, live])))

    const content = adapter.received[0].messages[0].content
    assert.equal(content[1].type, 'text')
    assert.equal(content[2].type, 'image')
    assert.equal(content[2].attachment.attachmentId, live.attachmentId)
  } finally {
    await ctx.dispose?.()
  }
})

test('the listener runs once per request: the identity guard stops the re-dispatch', async () => {
  // This counter is registered before the plugin is mounted, so it is upstream of
  // it and sees the original request as well as the replacement. One entry would
  // mean the plugin never re-dispatched; an unbounded count would mean the
  // `WeakSet` identity guard failed and the listener met its own replacement.
  let entered = 0
  const { ctx, adapter, store } = await harness({ report: false }, {
    before: (context) => {
      context.on('llm/stream', (options, next) => {
        entered += 1
        return next()
      })
    },
  })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    await drain(ctx.llm.stream(requestOf([gone])))

    assert.equal(entered, 2, 'the original request, then the replacement — and nothing more')
    assert.equal(adapter.received.length, 1, 'the adapter streamed the call once')
    assert.equal(ctx.get(SERVICE_NAME).snapshot().repaired, 1, 'one repair, not one per pass')
  } finally {
    await ctx.dispose?.()
  }
})

test('observe mode forwards the request unchanged and only counts', async () => {
  const { ctx, adapter, store } = await harness({ mode: 'observe', report: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    await drain(ctx.llm.stream(requestOf([gone])))

    assert.equal(adapter.received.length, 1)
    const content = adapter.received[0].messages[0].content
    assert.equal(content[1].type, 'image', 'observe mode changes no request')
    const service = ctx.get(SERVICE_NAME)
    assert.equal(service.snapshot().wouldRepair, 1)
    assert.equal(service.snapshot().repaired, 0)
    assert.equal(service.snapshot().mode, 'observe')
  } finally {
    await ctx.dispose?.()
  }
})

test('off mode installs no listener at all', async () => {
  const { ctx, adapter, store } = await harness({ mode: 'off', report: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    await drain(ctx.llm.stream(requestOf([gone])))

    assert.equal(adapter.received[0].messages[0].content[1].type, 'image')
    assert.equal(ctx.get(SERVICE_NAME).snapshot().mode, 'off')
  } finally {
    await ctx.dispose?.()
  }
})

test('a deep-frozen request is not mutated by the repair', async () => {
  const { ctx, adapter, store } = await harness({ report: false })
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    rmSync(store.imageHostPath(gone))

    const block = Object.freeze({ type: 'image', attachment: gone })
    const content = Object.freeze([{ type: 'text', text: 'frozen' }, block])
    const messages = Object.freeze([Object.freeze({ role: 'user', content })])
    const request = Object.freeze({ provider: 'recording', model: 'recording-model', messages })

    await drain(ctx.llm.stream(request))

    assert.equal(content[1], block, 'the original content still holds the image block')
    assert.equal(adapter.received[0].messages[0].content[1].type, 'text')
    assert.notEqual(adapter.received[0], request, 'the adapter received a replacement object')
  } finally {
    await ctx.dispose?.()
  }
})

test('the plugin mounts without an attachment service and changes nothing', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['recording'], adapter)
    await ctx.plugin(plugin, { report: false })

    const request = {
      provider: 'recording',
      model: 'recording-model',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
    }
    await drain(ctx.llm.stream(request))

    assert.equal(adapter.received[0].messages[0].content[0].type, 'image')
    assert.equal(ctx.get(SERVICE_NAME).snapshot().repaired, 0)
  } finally {
    await ctx.dispose?.()
  }
})
