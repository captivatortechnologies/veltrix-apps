import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { checkXml, normalizeXml, DECODERS_FILENAME_RE } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (checkXml / normalizeXml), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.filename ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  filename: 'local_decoder.xml',
  decodersXml: '<decoder name="my-app"><prematch>^my-app:</prematch></decoder>',
}

test('validate rejects a filename that does not end in .xml', async () => {
  const res = await validate(ctxOf([{ ...good, filename: 'local_decoder' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unsafe filename (path segments)', async () => {
  const res = await validate(ctxOf([{ ...good, filename: '../etc/decoders.xml' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate errors when the filename is empty', async () => {
  const res = await validate(ctxOf([{ ...good, filename: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when the decoders XML is empty', async () => {
  const res = await validate(ctxOf([{ ...good, decodersXml: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_XML'))
})

test('validate accepts a good decoders file', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns (but passes) when the decoders XML is not well-formed', async () => {
  const res = await validate(ctxOf([{ ...good, decodersXml: '<decoder><prematch></decoder>' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MALFORMED_XML'))
})

test('validate warns on a duplicate filename', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('checkXml accepts balanced XML and rejects mismatched/unclosed tags', () => {
  assert.equal(checkXml('<decoder><prematch/></decoder>').valid, true)
  assert.equal(checkXml('<decoder><prematch></decoder>').valid, false)
  assert.equal(checkXml('<decoder>').valid, false)
  assert.equal(checkXml('').valid, false)
})

test('normalizeXml collapses inter-tag whitespace for a stable comparison', () => {
  assert.equal(normalizeXml('<decoder>\n  <prematch/>\n</decoder>'), '<decoder><prematch/></decoder>')
})

test('DECODERS_FILENAME_RE requires a safe .xml basename', () => {
  assert.equal(DECODERS_FILENAME_RE.test('local_decoder.xml'), true)
  assert.equal(DECODERS_FILENAME_RE.test('0100-custom.xml'), true)
  assert.equal(DECODERS_FILENAME_RE.test('local_decoder'), false)
  assert.equal(DECODERS_FILENAME_RE.test('sub/decoders.xml'), false)
})
