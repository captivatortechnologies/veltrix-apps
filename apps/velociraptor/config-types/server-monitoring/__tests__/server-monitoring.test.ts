import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildServerMonitoring,
  liveServerArtifacts,
  readServerMonitoring,
  setServerMonitoringVQL,
  GET_SERVER_MONITORING_VQL,
  type ServerMonitoringConfig,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.scope ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = { scope: 'server', artifacts: 'Server.Monitor.Health\nElastic.Flows.Upload', enabled: true }

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires artifacts when enabled', async () => {
  const res = await validate(ctxOf([{ ...good, artifacts: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ARTIFACTS'))
})

test('validate requires a scope', async () => {
  const res = await validate(ctxOf([{ ...good, scope: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPE'))
})

test('validate accepts a disabled config with no artifacts', async () => {
  const res = await validate(ctxOf([{ ...good, artifacts: '', enabled: false }]))
  assert.equal(res.valid, true)
})

test('validate warns when more than one item is provided (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.ok(res.warnings.some((w) => w.code === 'SINGLETON'))
})

test('validate accepts a good singleton', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a malformed server event artifact name', async () => {
  const res = await validate(ctxOf([{ ...good, artifacts: 'Server.Monitor.Health, not valid!' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ARTIFACT_NAME'))
})

test('validate checks artifact name format even when disabled', async () => {
  const res = await validate(ctxOf([{ ...good, artifacts: 'bad name', enabled: false }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ARTIFACT_NAME'))
})

// --- value shaping ------------------------------------------------------------

test('buildServerMonitoring sets the artifact list when enabled', () => {
  const cfg = buildServerMonitoring(null, ['A', 'B'], true)
  assert.deepEqual(liveServerArtifacts(cfg), ['A', 'B'])
})

test('buildServerMonitoring clears the artifact list when disabled', () => {
  const cfg = buildServerMonitoring({ artifacts: { artifacts: ['A'] } }, ['A', 'B'], false)
  assert.deepEqual(liveServerArtifacts(cfg), [])
})

test('buildServerMonitoring preserves unrelated keys and does not mutate input', () => {
  const current: ServerMonitoringConfig = { artifacts: { artifacts: ['Old'] }, extra: 1 }
  const cfg = buildServerMonitoring(current, ['New'], true)
  assert.equal(cfg.extra, 1)
  assert.deepEqual(liveServerArtifacts(cfg), ['New'])
  assert.deepEqual(current.artifacts?.artifacts, ['Old'])
})

// --- reading + VQL ------------------------------------------------------------

test('readServerMonitoring pulls the config column', () => {
  const cfg = readServerMonitoring([{ config: { artifacts: { artifacts: ['A'] } } }])
  assert.deepEqual(cfg?.artifacts?.artifacts, ['A'])
  assert.equal(readServerMonitoring([]), null)
})

test('setServerMonitoringVQL wraps the JSON in parse_json + set_server_monitoring', () => {
  const vql = setServerMonitoringVQL('{"artifacts":{"artifacts":["A"]}}')
  assert.match(vql, /set_server_monitoring\(value=parse_json\(data='/)
  assert.match(vql, /FROM scope\(\)/)
})

test('GET_SERVER_MONITORING_VQL reads the current state', () => {
  assert.match(GET_SERVER_MONITORING_VQL, /get_server_monitoring\(\)/)
})
