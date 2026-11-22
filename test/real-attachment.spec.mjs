/**
 * The predicate and the failure, measured on the real attachment backend.
 *
 * Nothing here is a double except the store's home directory: `LocalAttachmentStore`
 * is the shipped host-file-backed backend at 0.2.3-alpha.1, the object is a real
 * normalized PNG written by it, and the "missing" state is produced by deleting
 * that real object. This is the evidence the plugin's predicate rests on, because
 * a store double that closes over its own answers would prove nothing about
 * `imageHostPath` or about the error the adapter actually meets.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { placeholder, scan } from '../lib/guard.js'

/**
 * Two real PNGs with different bytes. The backend is content-addressed, so two
 * copies of one image share one object on disk and deleting it would make both
 * references dangle — which is a property of the store, not of the predicate.
 */
const PNG_RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAD0lEQVR4nGNgYPgPQ5gsAH2gCPgfW8MjAAAAAElFTkSuQmCC',
  'base64',
)

/** Mount the real local backend over a private home, and hand back its root. */
async function mountStore() {
  const home = mkdtempSync(join(tmpdir(), 'dig-store-'))
  const ctx = new Context()
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.start?.()
  return { ctx, home, store: ctx.attachments ?? ctx.get('attachments') }
}

test('the real backend writes a normalized object and reports its host path', async () => {
  const { ctx, store } = await mountStore()
  try {
    const ref = await store.saveImage({ data: PNG_RED, mediaType: 'image/png', name: 'dot.png' })

    const path = store.imageHostPath(ref)
    assert.equal(typeof path, 'string', 'a host-file-backed store answers with a path')
    assert.equal(existsSync(path), true, 'the path it reports is where the object really is')

    const stored = await store.readImage(ref)
    assert.equal(stored.ref.attachmentId, ref.attachmentId)
    assert.ok(stored.data.byteLength > 0)

    assert.deepEqual(scan([{ role: 'user', content: [{ type: 'image', attachment: ref }] }], store, existsSync).dangling, [])
  } finally {
    await ctx.dispose?.()
  }
})

test('a deleted object is exactly what the adapter meets: ATTACHMENT_NOT_FOUND', async () => {
  const { ctx, store } = await mountStore()
  try {
    const ref = await store.saveImage({ data: PNG_RED, mediaType: 'image/png' })
    const path = store.imageHostPath(ref)
    rmSync(path)

    // `packages/llm/llm-deepseek/src/images.ts` reads through `readImageRequest`,
    // which derives its request version from `readImage` when no stored bytes are
    // handed to it — so this is the call whose failure the adapter sees.
    for (const read of [
      () => store.readImage(ref),
      () => store.readImageRequest(ref, { width: 64, height: 64, maxImageBytes: 1_000_000, imageTargetBytes: 900_000 }),
    ]) {
      let thrown
      try {
        await read()
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown !== undefined, 'the read rejects once the object is gone')
      assert.equal(thrown.code, 'ATTACHMENT_NOT_FOUND')
      assert.equal(thrown.name, 'AttachmentError')
      assert.notEqual(thrown.name, 'LlmError', 'it is not an LlmError, which is why the adapter rewraps it')
    }
  } finally {
    await ctx.dispose?.()
  }
})

test('the predicate recognises the real store\'s missing object and its readable neighbour', async () => {
  const { ctx, store } = await mountStore()
  try {
    const gone = await store.saveImage({ data: PNG_RED, mediaType: 'image/png', name: 'gone.png' })
    const live = await store.saveImage({ data: PNG_BLUE, mediaType: 'image/png', name: 'live.png' })
    rmSync(store.imageHostPath(gone))

    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'two images here' },
        { type: 'image', attachment: gone },
        { type: 'image', attachment: live },
      ],
    }]
    const found = scan(messages, store, existsSync)

    assert.equal(found.dangling.length, 1, 'only the deleted object is dangling')
    assert.equal(found.dangling[0].block, 1)
    assert.equal(found.dangling[0].ref.attachmentId, gone.attachmentId)
    assert.equal(found.present, 1, 'the readable image is counted present, not replaced')
    assert.equal(found.undecidable, 0, 'this backend answers for every reference it stored')
    assert.match(placeholder(found.dangling[0].ref), /gone\.png/)
  } finally {
    await ctx.dispose?.()
  }
})

test('a backend that is not host-file-backed is undecidable rather than missing', async () => {
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }]
  // The shipped base class's answer for a backend with no host objects.
  const found = scan(messages, { imageHostPath: () => undefined }, () => false)

  assert.equal(found.dangling.length, 0)
  assert.equal(found.undecidable, 1)
})
