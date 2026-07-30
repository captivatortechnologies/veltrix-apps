import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { checkXml, normalizeXml, GROUP_NAME_RE } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Wazuh REST API via
 * node:https inside wazuhApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (checkXml / normalizeXml), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  groupName: 'linux-servers',
  agentConf: '<agent_config><client><server><address>10.0.0.1</address></server></client></agent_config>',
}

test('validate rejects an unsafe group name', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: 'bad name/../x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate errors when the group name is empty', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good group with a shared agent.conf', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns (but passes) when a group has no shared agent.conf', async () => {
  const res = await validate(ctxOf([{ ...good, agentConf: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_SHARED_CONF'))
})

test('validate warns (but passes) when agent.conf is not well-formed XML', async () => {
  const res = await validate(ctxOf([{ ...good, agentConf: '<agent_config><client></agent_config>' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MALFORMED_XML'))
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('checkXml accepts balanced XML and rejects mismatched/unclosed tags', () => {
  assert.equal(checkXml('<a><b>x</b></a>').valid, true)
  assert.equal(checkXml('<a><b/></a>').valid, true)
  assert.equal(checkXml('<a><b></a>').valid, false)
  assert.equal(checkXml('<a>').valid, false)
  assert.equal(checkXml('').valid, false)
})

test('normalizeXml collapses inter-tag whitespace for a stable comparison', () => {
  assert.equal(normalizeXml('<a>\n  <b>x</b>\n</a>'), '<a><b>x</b></a>')
})

test('GROUP_NAME_RE accepts safe names and rejects spaces/slashes', () => {
  assert.equal(GROUP_NAME_RE.test('linux-servers'), true)
  assert.equal(GROUP_NAME_RE.test('web.01_prod'), true)
  assert.equal(GROUP_NAME_RE.test('bad name'), false)
  assert.equal(GROUP_NAME_RE.test('a/b'), false)
})
