import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSidecarConfigBody, bodyFromLiveSidecarConfig, parseSidecarTags, sidecarConfigSummariesFromList, findSidecarConfigSummary } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'filebeat-linux-prod',
  collector_name: 'filebeat',
  collector_os: 'linux',
  color: '#FF3B2F',
  tags: '["production"]',
  template: 'filebeat.inputs:\n  - type: log\n    paths: ["/var/log/*.log"]',
}

test('validate accepts a well-formed configuration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with hostile characters', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad;name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects a missing collector_name', async () => {
  const res = await validate(ctxOf([{ ...good, collector_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_COLLECTOR_NAME'))
})

test('validate rejects a missing template', async () => {
  const res = await validate(ctxOf([{ ...good, template: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEMPLATE'))
})

test('validate rejects malformed tags JSON', async () => {
  const res = await validate(ctxOf([{ ...good, tags: '{ nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TAGS_JSON'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, color: '#000000' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildSidecarConfigBody threads the resolved collector id', () => {
  const { body, error } = buildSidecarConfigBody(good, 'collector-1')
  assert.equal(error, undefined)
  assert.equal(body?.collector_id, 'collector-1')
  assert.deepEqual(body?.tags, ['production'])
})

test('bodyFromLiveSidecarConfig maps a live config back to a request body', () => {
  const body = bodyFromLiveSidecarConfig({ name: 'x', collector_id: 'c1', template: 'y' })
  assert.equal(body.collector_id, 'c1')
  assert.equal(body.template, 'y')
})

test('parseSidecarTags treats blank as an empty array', () => {
  assert.deepEqual(parseSidecarTags('').tags, [])
})

test('sidecarConfigSummariesFromList + findSidecarConfigSummary match by name', () => {
  const live = sidecarConfigSummariesFromList({ configurations: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] })
  assert.equal(live.length, 2)
  assert.equal(findSidecarConfigSummary(live, 'b')?.id, '2')
  assert.equal(findSidecarConfigSummary(live, 'nope'), null)
})
