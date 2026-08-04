import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildSidecarCollectorBody, bodyFromLiveSidecarCollector, sidecarCollectorsFromList, findSidecarCollector } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'filebeat',
  node_operating_system: 'linux',
  service_type: 'exec',
  executable_path: '/usr/share/filebeat/bin/filebeat',
  execute_parameters: '-c %s',
  validation_parameters: 'test config -c %s',
  default_template: '',
}

test('validate accepts a well-formed collector', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown operating system', async () => {
  const res = await validate(ctxOf([{ ...good, node_operating_system: 'plan9' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_OS'))
})

test('validate rejects "svc" service type on a non-Windows OS', async () => {
  const res = await validate(ctxOf([{ ...good, service_type: 'svc' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SERVICE_TYPE'))
})

test('validate accepts "svc" service type on Windows', async () => {
  const res = await validate(ctxOf([{ ...good, node_operating_system: 'windows', service_type: 'svc' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing executable path', async () => {
  const res = await validate(ctxOf([{ ...good, executable_path: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_EXECUTABLE_PATH'))
})

test('validate warns on a duplicate (name, os) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, executable_path: '/other/path' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_COLLECTOR'))
})

test('validate allows the same name on a different OS without warning', async () => {
  const res = await validate(ctxOf([good, { ...good, node_operating_system: 'windows', executable_path: 'C\\filebeat.exe' }]))
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_COLLECTOR'), false)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildSidecarCollectorBody lowercases the OS and defaults service_type', () => {
  const body = buildSidecarCollectorBody({ ...good, node_operating_system: 'Linux', service_type: '' })
  assert.equal(body.node_operating_system, 'linux')
  assert.equal(body.service_type, 'exec')
})

test('bodyFromLiveSidecarCollector maps a live collector back to a request body', () => {
  const body = bodyFromLiveSidecarCollector({ name: 'x', node_operating_system: 'LINUX', executable_path: '/bin/x' })
  assert.equal(body.node_operating_system, 'linux')
})

test('sidecarCollectorsFromList + findSidecarCollector match by (name, os) pair', () => {
  const live = sidecarCollectorsFromList({
    total: 2,
    collectors: [
      { id: '1', name: 'filebeat', node_operating_system: 'linux' },
      { id: '2', name: 'filebeat', node_operating_system: 'windows' },
    ],
  })
  assert.equal(live.length, 2)
  assert.equal(findSidecarCollector(live, 'filebeat', 'windows')?.id, '2')
  assert.equal(findSidecarCollector(live, 'filebeat', 'darwin'), null)
})
