import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildTaskTemplateInput, buildTaskTemplatePatch, findTaskTemplate, taskTemplatesFromList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus
 * on validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Triage Initial Evidence', description: 'Collect and review the initial evidence set.' }

test('validate rejects a missing task template name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate task template name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'A different description.' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good task template and an omitted description', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ name: 'Escalate to IR' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildTaskTemplateInput omits a blank description but keeps the name', () => {
  const input = buildTaskTemplateInput({ name: 'Escalate to IR', description: '' })
  assert.deepEqual(input, { name: 'Escalate to IR' })

  const full = buildTaskTemplateInput(good)
  assert.equal(full.description, good.description)
})

test('buildTaskTemplatePatch patches description and never patches the identity', () => {
  const patch = buildTaskTemplatePatch(good)
  assert.ok(patch.every((p) => p.key !== 'name'))
  const description = patch.find((p) => p.key === 'description')
  assert.deepEqual(description?.value, [good.description])
})

test('taskTemplatesFromList unwraps the edges/node connection', () => {
  const list = taskTemplatesFromList({
    taskTemplates: {
      edges: [
        { node: { id: '1', name: 'Triage Initial Evidence' } },
        { node: { id: '2', name: 'Escalate to IR' } },
      ],
    },
  })
  assert.equal(list.length, 2)
  assert.equal(findTaskTemplate(list, 'TRIAGE INITIAL EVIDENCE')?.id, '1')
})
