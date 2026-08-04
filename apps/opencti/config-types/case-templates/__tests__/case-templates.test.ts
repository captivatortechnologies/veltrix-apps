import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCaseTemplateInput,
  buildCaseTemplatePatch,
  caseTemplatesFromList,
  findCaseTemplate,
  resolveTaskTemplateIds,
  taskIdsOf,
  toStringList,
} from '../_shared'
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

const good = { name: 'Phishing Investigation', description: 'Standard phishing triage', task_template_names: ['Triage', 'Collect Artifacts'] }

test('validate rejects a missing case template name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a too-short name', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'A' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_SHORT'))
})

test('validate warns on a duplicate case template name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'dup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good case template and a name-only one', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ name: 'Bare Case' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toStringList normalizes array and comma-separated tag values', () => {
  assert.deepEqual(toStringList(['Triage', 'Triage', 'Collect']), ['Triage', 'Collect'])
  assert.deepEqual(toStringList('Triage, Collect'), ['Triage', 'Collect'])
  assert.deepEqual(toStringList(undefined), [])
})

test('resolveTaskTemplateIds matches case-insensitively and reports unresolved names', () => {
  const live = [
    { id: 't1', name: 'Triage' },
    { id: 't2', name: 'Collect Artifacts' },
  ]
  const { ids, unresolved } = resolveTaskTemplateIds(['triage', 'Nonexistent'], live)
  assert.deepEqual(ids, ['t1'])
  assert.deepEqual(unresolved, ['Nonexistent'])
})

test('buildCaseTemplateInput always sends tasks (required, may be empty) and omits a blank description', () => {
  const input = buildCaseTemplateInput({ name: 'Phishing Investigation', description: '' }, [])
  assert.deepEqual(input, { name: 'Phishing Investigation', tasks: [] })

  const full = buildCaseTemplateInput(good, ['t1', 't2'])
  assert.equal(full.description, 'Standard phishing triage')
  assert.deepEqual(full.tasks, ['t1', 't2'])
})

test('buildCaseTemplatePatch never patches the identity and always replaces tasks', () => {
  const patch = buildCaseTemplatePatch(good, ['t1'])
  assert.ok(patch.every((p) => p.key !== 'name'))
  const tasks = patch.find((p) => p.key === 'tasks')
  assert.deepEqual(tasks?.value, ['t1'])
})

test('taskIdsOf extracts ids from the tasks connection', () => {
  const ids = taskIdsOf({ tasks: { edges: [{ node: { id: 't1' } }, { node: { id: 't2' } }] } })
  assert.deepEqual(ids, ['t1', 't2'])
  assert.deepEqual(taskIdsOf({}), [])
})

test('caseTemplatesFromList unwraps the edges/node connection', () => {
  const list = caseTemplatesFromList({
    caseTemplates: { edges: [{ node: { id: '1', name: 'Phishing Investigation' } }, { node: { id: '2', name: 'Ransomware' } }] },
  })
  assert.equal(list.length, 2)
  assert.equal(findCaseTemplate(list, 'phishing investigation')?.id, '1')
})
