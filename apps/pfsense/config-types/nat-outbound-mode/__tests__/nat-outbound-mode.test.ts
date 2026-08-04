import test from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractSpecs } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctx(items: Array<{ id: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { canvasId: 'c', items }, component: { id: 'p', type: 'pfsense-firewall' }, credential: null, connectivity: null, settings: {}, platform: {} } as unknown as PipelineContext
}

test('accepts exactly one supported mode', async () => {
  const result = await validate(ctx([{ id: 'm', fields: { mode: 'hybrid' } }]))
  assert.equal(result.valid, true)
  assert.equal(extractSpecs(ctx([{ id: 'm', fields: { mode: 'advanced' } }]).canvas)[0].mode, 'advanced')
})

test('rejects missing, duplicate, and unsupported modes', async () => {
  assert.equal((await validate(ctx([]))).valid, false)
  assert.equal((await validate(ctx([{ id: 'a', fields: { mode: 'automatic' } }, { id: 'b', fields: { mode: 'hybrid' } }]))).valid, false)
  assert.equal((await validate(ctx([{ id: 'a', fields: { mode: 'manual' } }]))).valid, false)
})
