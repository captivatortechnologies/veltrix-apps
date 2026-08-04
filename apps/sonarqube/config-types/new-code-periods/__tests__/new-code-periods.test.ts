import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { levelLabel, NEW_CODE_TYPES } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.project ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const globalPreviousVersion = { project: '', branch: '', type: 'PREVIOUS_VERSION', value: '' }
const projectNumberOfDays = { project: 'my-project', branch: '', type: 'NUMBER_OF_DAYS', value: '30' }

// --- validate ----------------------------------------------------------------

test('validate accepts a global PREVIOUS_VERSION definition', async () => {
  const res = await validate(ctxOf([globalPreviousVersion]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a project-level NUMBER_OF_DAYS(30) definition', async () => {
  const res = await validate(ctxOf([projectNumberOfDays]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects NUMBER_OF_DAYS above 90', async () => {
  const res = await validate(ctxOf([{ ...projectNumberOfDays, value: '200' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DAYS'))
})

test('validate rejects NUMBER_OF_DAYS of 0', async () => {
  const res = await validate(ctxOf([{ ...projectNumberOfDays, value: '0' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DAYS'))
})

test('validate rejects a branch without a project', async () => {
  const res = await validate(ctxOf([{ project: '', branch: 'feature-x', type: 'PREVIOUS_VERSION', value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'BRANCH_REQUIRES_PROJECT'))
})

test('validate rejects REFERENCE_BRANCH at the global level', async () => {
  const res = await validate(ctxOf([{ project: '', branch: '', type: 'REFERENCE_BRANCH', value: 'main' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'GLOBAL_NOT_ALLOWED'))
})

test('validate rejects SPECIFIC_ANALYSIS without a branch, and warns about ephemeral analyses when valid', async () => {
  const noBranch = await validate(ctxOf([{ project: 'my-project', branch: '', type: 'SPECIFIC_ANALYSIS', value: 'abc-123' }]))
  assert.equal(noBranch.valid, false)
  assert.ok(noBranch.errors.some((e) => e.code === 'BRANCH_ONLY_TYPE'))

  const valid = await validate(ctxOf([{ project: 'my-project', branch: 'main', type: 'SPECIFIC_ANALYSIS', value: 'abc-123' }]))
  assert.equal(valid.valid, true)
  assert.ok(valid.warnings.some((w) => w.code === 'EPHEMERAL_ANALYSIS'))
})

test('validate requires a value for SPECIFIC_ANALYSIS', async () => {
  const res = await validate(ctxOf([{ project: 'my-project', branch: 'main', type: 'SPECIFIC_ANALYSIS', value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate requires a value for REFERENCE_BRANCH', async () => {
  const res = await validate(ctxOf([{ project: 'my-project', branch: '', type: 'REFERENCE_BRANCH', value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate warns when PREVIOUS_VERSION carries a stray value', async () => {
  const res = await validate(ctxOf([{ ...globalPreviousVersion, value: '30' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_VALUE'))
})

test('validate warns on a duplicate (project, branch) level', async () => {
  const res = await validate(ctxOf([projectNumberOfDays, { ...projectNumberOfDays, value: '60' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_LEVEL'))
})

test('validate rejects an unknown type', async () => {
  const res = await validate(ctxOf([{ ...globalPreviousVersion, type: 'BOGUS' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared -------------------------------------------------------------------

test('levelLabel returns (global) when both project and branch are blank', () => {
  assert.equal(levelLabel('', ''), '(global)')
  assert.equal(levelLabel(undefined, undefined), '(global)')
})

test('levelLabel returns the project key when branch is blank', () => {
  assert.equal(levelLabel('my-project', ''), 'my-project')
})

test('levelLabel returns project#branch when both are set', () => {
  assert.equal(levelLabel('my-project', 'feature-x'), 'my-project#feature-x')
})

test('NEW_CODE_TYPES contains exactly the four known types', () => {
  assert.deepEqual([...NEW_CODE_TYPES].sort(), ['NUMBER_OF_DAYS', 'PREVIOUS_VERSION', 'REFERENCE_BRANCH', 'SPECIFIC_ANALYSIS'])
})
