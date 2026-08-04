import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { checkXml, normalizeXml, hasOssecConfigRoot } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared parsing helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodXml = '<ossec_config><global><jsonout_output>yes</jsonout_output></global></ossec_config>'
const good = { configLabel: 'ossec.conf (manager)', ossecConfXml: goodXml }

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects an empty ossec.conf body', async () => {
  const res = await validate(ctxOf([{ ...good, ossecConfXml: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_XML'))
})

test('validate warns (but passes) with more than one item', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON_EXCESS'))
})

test('validate warns on malformed XML', async () => {
  const res = await validate(ctxOf([{ ...good, ossecConfXml: '<ossec_config><unclosed>' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MALFORMED_XML'))
})

test('validate warns when the root element is not <ossec_config>', async () => {
  const res = await validate(ctxOf([{ ...good, ossecConfXml: '<not_ossec><a/></not_ossec>' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNEXPECTED_ROOT'))
})

test('validate always includes the whole-file-replace warning for a non-empty body', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'WHOLE_FILE_REPLACE'))
})

test('checkXml accepts a well-formed document and rejects an unclosed tag', () => {
  assert.equal(checkXml(goodXml).valid, true)
  assert.equal(checkXml('<a><b></a>').valid, false)
  assert.equal(checkXml('').valid, false)
})

test('normalizeXml drops comments and inter-tag whitespace', () => {
  assert.equal(normalizeXml('<a>\n  <!-- x --> <b/>\n</a>'), '<a><b/></a>')
})

test('hasOssecConfigRoot detects the documented root element, tolerating a prolog', () => {
  assert.equal(hasOssecConfigRoot(goodXml), true)
  assert.equal(hasOssecConfigRoot('<?xml version="1.0"?>\n' + goodXml), true)
  assert.equal(hasOssecConfigRoot('<not_ossec/>'), false)
})
