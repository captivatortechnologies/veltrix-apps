import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildRuleBody, findRuleByName, normalizeEnabled, normalizePriority, splitTags } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigRule } from '../../../lib/sysdigApi'

/**
 * The deploy/rollback/drift handlers call the Sysdig Secure REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * mapping helpers in _shared.ts, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Unexpected outbound connection',
  description: 'Detects netcat in a container',
  condition: 'evt.type=execve and proc.name=nc',
  output: 'Netcat run (user=%user.name command=%proc.cmdline)',
  priority: 'WARNING',
  source: 'syscall',
  enabled: true,
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing condition', async () => {
  const res = await validate(ctxOf([{ ...good, condition: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CONDITION'))
})

test('validate rejects a missing output', async () => {
  const res = await validate(ctxOf([{ ...good, output: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_OUTPUT'))
})

test('validate rejects an unknown priority', async () => {
  const res = await validate(ctxOf([{ ...good, priority: 'SEVERE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIORITY'))
})

test('validate accepts a lowercase priority (normalized)', async () => {
  const res = await validate(ctxOf([{ ...good, priority: 'critical' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an unknown source', async () => {
  const res = await validate(ctxOf([{ ...good, source: 'kernel' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SOURCE'))
})

test('validate warns on a duplicate rule name', async () => {
  const res = await validate(ctxOf([good, { ...good, condition: 'evt.type=open' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good rule for each source', async () => {
  for (const source of ['syscall', 'k8s_audit', 'aws_cloudtrail', 'gcp_auditlog', 'azure_platformlogs', 'okta', 'github', 'guardduty']) {
    const res = await validate(ctxOf([{ ...good, source }]))
    assert.equal(res.valid, true, `expected ${source} to be valid`)
  }
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeEnabled defaults to enabled and reads disabled/false/0', () => {
  assert.equal(normalizeEnabled(undefined), true)
  assert.equal(normalizeEnabled(true), true)
  assert.equal(normalizeEnabled('enabled'), true)
  assert.equal(normalizeEnabled(false), false)
  assert.equal(normalizeEnabled('disabled'), false)
  assert.equal(normalizeEnabled('0'), false)
  assert.equal(normalizeEnabled('no'), false)
})

test('normalizePriority upper-cases and trims', () => {
  assert.equal(normalizePriority('critical'), 'CRITICAL')
  assert.equal(normalizePriority('  Warning '), 'WARNING')
})

test('splitTags handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitTags(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitTags('a, b\nc'), ['a', 'b', 'c'])
  assert.deepEqual(splitTags(undefined), [])
})

test('buildRuleBody maps canvas fields to the Sysdig FALCO rule shape', () => {
  const rule = buildRuleBody({ ...good, tags: 'mitre_execution, network' })
  assert.equal(rule.name, good.name)
  assert.equal(rule.description, good.description)
  assert.deepEqual(rule.tags, ['mitre_execution', 'network'])
  assert.equal(rule.details.ruleType, 'FALCO')
  assert.equal(rule.details.source, 'syscall')
  assert.equal(rule.details.priority, 'WARNING')
  assert.equal(rule.details.output, good.output)
  assert.equal(rule.details.condition?.condition, good.condition)
  assert.deepEqual(rule.details.condition?.components, [])
  assert.equal(rule.details.append, false)
})

test('findRuleByName matches by exact name', () => {
  const rules: SysdigRule[] = [
    { name: 'A', details: { ruleType: 'FALCO' } },
    { name: 'Unexpected outbound connection', id: 42, details: { ruleType: 'FALCO' } },
  ]
  assert.equal(findRuleByName(rules, 'Unexpected outbound connection')?.id, 42)
  assert.equal(findRuleByName(rules, 'missing'), null)
  assert.equal(findRuleByName(rules, ''), null)
})
