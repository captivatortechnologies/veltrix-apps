import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractPipelineName, buildPipelineBody, normalizePipelineSource, pipelinesFromList, findPipeline, RESERVED_PIPELINE_NAME } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Graylog REST API via
 * node:https inside graylogApi, which is impractical to mock here. Tests focus on
 * validate.ts and the pure _shared helpers (pipeline-name extraction, body
 * building, source normalization, identity matching).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.title ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  title: 'route-firewall',
  description: 'routes firewall messages',
  source: 'pipeline "route-firewall"\nstage 0 match either\n  rule "add-source-tag"\nend',
}

test('validate accepts a well-formed pipeline whose title matches the source', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing title', async () => {
  const res = await validate(ctxOf([{ ...good, title: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TITLE'))
})

test('validate rejects the reserved "Default Routing" name', async () => {
  const res = await validate(ctxOf([{ ...good, title: RESERVED_PIPELINE_NAME, source: `pipeline "${RESERVED_PIPELINE_NAME}"\nstage 0 match either\n  rule "x"\nend` }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'RESERVED_NAME'))
})

test('validate rejects a missing source', async () => {
  const res = await validate(ctxOf([{ ...good, source: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SOURCE'))
})

test('validate rejects a source with no pipeline declaration', async () => {
  const res = await validate(ctxOf([{ ...good, source: 'stage 0 match either rule "x" end' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_PIPELINE_NAME'))
})

test('validate rejects a title that does not match the pipeline name', async () => {
  const res = await validate(ctxOf([{ ...good, title: 'different-name' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'PIPELINE_NAME_MISMATCH'))
})

test('validate warns on a duplicate pipeline title', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TITLE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('extractPipelineName pulls the quoted name from the DSL', () => {
  assert.equal(extractPipelineName('pipeline "my pipeline" stage 0 match either rule "x" end'), 'my pipeline')
  assert.equal(extractPipelineName('  pipeline   "spaced"\nstage 0'), 'spaced')
  assert.equal(extractPipelineName('no pipeline here'), null)
})

test('buildPipelineBody trims the source and carries title + description', () => {
  const body = buildPipelineBody({ ...good, source: `  ${good.source}  ` })
  assert.equal(body.title, 'route-firewall')
  assert.equal(body.description, 'routes firewall messages')
  assert.ok(body.source.startsWith('pipeline "route-firewall"'))
})

test('normalizePipelineSource collapses whitespace so formatting is not drift', () => {
  const a = normalizePipelineSource('pipeline "x"\n  stage   0\nmatch either end')
  const b = normalizePipelineSource('pipeline "x" stage 0 match either end')
  assert.equal(a, b)
})

test('pipelinesFromList + findPipeline match by title from the bare array', () => {
  const live = pipelinesFromList([{ id: '1', title: 'route-firewall' }, { id: '2', title: 'route-dns' }])
  assert.equal(live.length, 2)
  assert.equal(findPipeline(live, 'route-dns')?.id, '2')
  assert.equal(findPipeline(live, 'nope'), null)
})
