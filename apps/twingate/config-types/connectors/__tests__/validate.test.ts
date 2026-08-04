import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildCreateVariables, buildUpdateVariables, extractConnectorSpecs } from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvas(fields: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = fields.map((value, index) => ({ id: `i${index}`, name: `item${index}`, fields: value }))
  return { id: 's', canvasId: 'c', version: 1, name: 'Connectors', toolType: 'twingate', entityType: 'connectors', items, sections: items, snapshot: {} }
}

function ctx(fields: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvas(fields) } as unknown as PipelineContext
}

test('validate requires connector and Remote Network names', async () => {
  const result = await validate(ctx([{}]))
  assert.equal(result.valid, false)
  assert.equal(result.errors.filter((error) => error.code === 'required').length, 2)
})

test('validate rejects duplicate connector names case-insensitively', async () => {
  const result = await validate(ctx([{ name: 'East', remote_network_name: 'HQ' }, { name: 'east', remote_network_name: 'HQ' }]))
  assert.ok(result.errors.some((error) => error.code === 'duplicate_connector'))
})

test('create carries placement while update cannot move a connector', () => {
  const spec = extractConnectorSpecs(canvas([{ name: 'East', remote_network_name: 'HQ', status_updates_enabled: false }]))[0]
  assert.equal(buildCreateVariables(spec, 'network-1').remoteNetworkId, 'network-1')
  assert.equal('remoteNetworkId' in buildUpdateVariables('connector-1', spec), false)
})
