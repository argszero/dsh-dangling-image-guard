/**
 * The predicate, exercised against a store double and an injected existence
 * probe. Nothing here needs a harness: the module under test imports no harness
 * package, which is the property the entry row depends on.
 *
 * @module
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { placeholder, rewrite, scan } from '../lib/guard.js'

/** One image reference, shaped like the durable reference a request carries. */
function ref(id, extra = {}) {
  return { attachmentId: id, mediaType: 'image/png', bytes: 128, width: 8, height: 4, ...extra }
}

/** One image block. */
function image(id, extra = {}) {
  return { type: 'image', attachment: ref(id, extra) }
}

/** One text block. */
function text(value) {
  return { type: 'text', text: value }
}

/** A store that answers for exactly the ids it was given. */
function storeOf(paths) {
  return { imageHostPath: (attachment) => paths[attachment.attachmentId] }
}

test('a reference whose host path is absent is reported as dangling', () => {
  const messages = [{ role: 'user', content: [text('look'), image('a'), text('done')] }]
  const store = storeOf({ a: '/store/objects/a.png' })

  const found = scan(messages, store, () => false)

  assert.equal(found.dangling.length, 1)
  assert.equal(found.dangling[0].message, 0)
  assert.equal(found.dangling[0].block, 1, 'the block index is the image, not the text before it')
  assert.equal(found.dangling[0].path, '/store/objects/a.png')
  assert.equal(found.present, 0)
})

test('a reference whose host path exists is left alone', () => {
  const messages = [{ role: 'user', content: [image('a')] }]
  const found = scan(messages, storeOf({ a: '/store/objects/a.png' }), () => true)

  assert.deepEqual(found.dangling, [])
  assert.equal(found.present, 1)
})

test('a backend that reports no host path is counted undecidable, never guessed at', () => {
  const messages = [{ role: 'user', content: [image('a')] }]
  // The shipped base class returns `undefined` for a backend that is not
  // host-file-backed; treating that as "missing" would degrade a readable image.
  const found = scan(messages, storeOf({}), () => false)

  assert.deepEqual(found.dangling, [])
  assert.equal(found.undecidable, 1)
  assert.equal(found.present, 0)
})

test('an image the core already offloaded is not degraded a second time', () => {
  const messages = [{ role: 'user', content: [{ type: 'image', attachment: ref('a'), offloaded: true }] }]
  const found = scan(messages, storeOf({ a: '/store/objects/a.png' }), () => false)

  assert.deepEqual(found.dangling, [])
  assert.equal(found.alreadyOffloaded, 1)
})

test('a store that refuses the reference is counted, and the request is left to the store', () => {
  const messages = [{ role: 'user', content: [image('bad')] }]
  const store = {
    imageHostPath: () => {
      throw new Error('invalid durable reference')
    },
  }
  const found = scan(messages, store, () => false)

  assert.deepEqual(found.dangling, [])
  assert.equal(found.unreadable, 1)
})

test('non-image blocks and unknown block types are ignored', () => {
  const messages = [{
    role: 'user',
    content: [text('x'), { type: 'file', attachment: ref('f') }, { type: 'something-else' }],
  }]
  const found = scan(messages, storeOf({ f: '/store/files/f' }), () => false)

  assert.deepEqual(found.dangling, [])
  assert.equal(found.present + found.undecidable + found.alreadyOffloaded + found.unreadable, 0)
})

test('every dangling occurrence in one message is replaced, and healthy neighbours survive', () => {
  const messages = [{ role: 'user', content: [image('gone'), text('between'), image('live')] }]
  const store = storeOf({ gone: '/store/objects/gone.png', live: '/store/objects/live.png' })
  const found = scan(messages, store, (path) => path.endsWith('live.png'))
  assert.equal(found.dangling.length, 1)

  const next = rewrite(messages, found.dangling)

  assert.equal(next[0].content.length, 3, 'the block count is preserved')
  assert.equal(next[0].content[0].type, 'text')
  assert.match(next[0].content[0].text, /image unavailable/)
  assert.equal(next[0].content[1].text, 'between')
  assert.equal(next[0].content[2].type, 'image', 'the readable image stays an image')
  assert.equal(next[0].content[2].attachment.attachmentId, 'live')
})

test('two dangling images in one message both become text', () => {
  const messages = [{ role: 'user', content: [image('a'), image('b')] }]
  const found = scan(messages, storeOf({ a: '/a', b: '/b' }), () => false)

  const next = rewrite(messages, found.dangling)

  assert.equal(next[0].content.length, 2)
  assert.notEqual(next[0].content[0].text, next[0].content[1].text, 'each placeholder names its own image')
})

test('messages without a dangling occurrence are returned by identity', () => {
  const clean = { role: 'assistant', content: [text('nothing here')] }
  const messages = [{ role: 'user', content: [image('gone')] }, clean]
  const found = scan(messages, storeOf({ gone: '/gone' }), () => false)

  const next = rewrite(messages, found.dangling)

  assert.notEqual(next[0], messages[0], 'the message holding the dangling image is copied')
  assert.equal(next[1], clean, 'an untouched message keeps its identity')
})

test('rewrite never mutates the input, so a deep-frozen request survives', () => {
  const frozenRef = Object.freeze(ref('gone'))
  const frozenBlock = Object.freeze({ type: 'image', attachment: frozenRef })
  const frozenContent = Object.freeze([frozenBlock])
  const frozen = Object.freeze([Object.freeze({ role: 'user', content: frozenContent })])

  const found = scan(frozen, storeOf({ gone: '/gone' }), () => false)
  const next = rewrite(frozen, found.dangling)

  assert.equal(frozen[0].content[0], frozenBlock, 'the original block is still the image')
  assert.equal(frozen[0].content.length, 1)
  assert.equal(next[0].content[0].type, 'text')
})

test('the placeholder names the identity, the media type and the failing conclusion', () => {
  const message = placeholder(ref('abc123', { name: 'chart.png' }))

  assert.match(message, /image unavailable/)
  assert.match(message, /abc123/)
  assert.match(message, /chart\.png/)
  assert.match(message, /image\/png/)
  assert.match(message, /8\u00d74/)
  assert.match(message, /no object/)
  assert.match(message, /attach the image again/, 'it tells the reader what to do next')
})

test('a reference without the optional metadata still produces a readable line', () => {
  const message = placeholder({ attachmentId: 'bare' })

  assert.match(message, /bare/)
  assert.doesNotMatch(message, /undefined/)
  assert.doesNotMatch(message, /NaN/)
})
