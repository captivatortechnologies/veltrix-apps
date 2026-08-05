import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildApplicationScopeBody, diffApplicationScope, extractApplicationScopeSpecs } from '../_shared'
import type { PipelineContext, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { AquaApplicationScope } from '../../../lib/aquasec'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  return { items: list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields })) } as unknown as CanvasSnapshot
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = {
  name: 'payments-prod',
  description: 'Payments production workloads',
  ownerEmail: 'team@example.com',
  imageExpression: 'v1',
  imageVariables: { 'image.repo': 'payments' },
  kubernetesWorkloadExpression: 'v1',
  kubernetesWorkloadVariables: { 'kubernetes.namespace': 'payments' },
}

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a malformed owner email', async () => {
  const res = await validate(ctxOf([{ ...good, ownerEmail: 'not-an-email' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate warns on a scope with no dimensions populated', async () => {
  const res = await validate(ctxOf([{ name: 'empty-scope' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_SCOPE'))
})

test('validate does not warn "Global" for having no explicit dimensions', async () => {
  const res = await validate(ctxOf([{ name: 'Global' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'EMPTY_SCOPE'))
})

test('buildApplicationScopeBody maps a spec to the Aqua wire shape', () => {
  const [spec] = extractApplicationScopeSpecs(canvasOf([good]))
  const body = buildApplicationScopeBody(spec)
  assert.equal(body.name, 'payments-prod')
  assert.deepEqual(body.categories?.artifacts?.image, { expression: 'v1', variables: [{ attribute: 'image.repo', value: 'payments' }] })
  assert.deepEqual(body.categories?.workloads?.kubernetes, { expression: 'v1', variables: [{ attribute: 'kubernetes.namespace', value: 'payments' }] })
  assert.equal(body.categories?.infrastructure?.kubernetes, undefined)
})

test('diffApplicationScope reports no drift when the live scope matches the spec', () => {
  const [spec] = extractApplicationScopeSpecs(canvasOf([good]))
  const live = buildApplicationScopeBody(spec) as AquaApplicationScope
  assert.deepEqual(diffApplicationScope(spec, live), [])
})

test('diffApplicationScope flags a changed image expression as critical', () => {
  const [spec] = extractApplicationScopeSpecs(canvasOf([good]))
  const live: AquaApplicationScope = {
    ...(buildApplicationScopeBody(spec) as AquaApplicationScope),
    categories: { artifacts: { image: { expression: 'v1', variables: [{ attribute: 'image.repo', value: 'other' }] } } },
  }
  const diffs = diffApplicationScope(spec, live)
  const found = diffs.find((d) => d.field === 'payments-prod.imageScope')
  assert.ok(found)
  assert.equal(found?.severity, 'critical')
})
