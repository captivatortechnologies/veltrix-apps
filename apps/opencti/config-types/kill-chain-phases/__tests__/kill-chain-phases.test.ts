import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildKillChainPhaseInput,
  buildKillChainPhasePatch,
  findKillChainPhase,
  killChainPhasesFromList,
  normalizeOrder,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the OpenCTI GraphQL API via
 * node:https inside openctiApi, which is impractical to mock here. Tests focus on
 * validate.ts (pure, network-free) and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.phase_name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { kill_chain_name: 'mitre-attack', phase_name: 'initial-access', x_opencti_order: 1 }

test('validate rejects a missing kill chain name', async () => {
  const res = await validate(ctxOf([{ ...good, kill_chain_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KILL_CHAIN_NAME'))
})

test('validate rejects a missing phase name', async () => {
  const res = await validate(ctxOf([{ ...good, phase_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PHASE_NAME'))
})

test('validate rejects a negative / non-integer order', async () => {
  const neg = await validate(ctxOf([{ ...good, x_opencti_order: -1 }]))
  assert.equal(neg.valid, false)
  assert.ok(neg.errors.some((e) => e.code === 'INVALID_ORDER'))

  const frac = await validate(ctxOf([{ ...good, x_opencti_order: 2.5 }]))
  assert.equal(frac.valid, false)
  assert.ok(frac.errors.some((e) => e.code === 'INVALID_ORDER'))
})

test('validate warns on a duplicate kill_chain_name + phase_name pair', async () => {
  const res = await validate(ctxOf([good, { ...good, x_opencti_order: 5 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_KILL_CHAIN_PHASE'))
})

test('validate allows the same phase_name across different kill chains', async () => {
  const res = await validate(ctxOf([good, { ...good, kill_chain_name: 'lockheed-martin-cyber-kill-chain' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.some((w) => w.code === 'DUPLICATE_KILL_CHAIN_PHASE'), false)
})

test('validate accepts a good phase and an omitted order', async () => {
  const full = await validate(ctxOf([good]))
  assert.equal(full.valid, true)
  assert.equal(full.errors.length, 0)

  const bare = await validate(ctxOf([{ kill_chain_name: 'mitre-attack', phase_name: 'reconnaissance' }]))
  assert.equal(bare.valid, true)
  assert.equal(bare.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeOrder defaults blank/invalid values to 0 (the create input requires Int!)', () => {
  assert.equal(normalizeOrder(undefined), 0)
  assert.equal(normalizeOrder(''), 0)
  assert.equal(normalizeOrder('not-a-number'), 0)
  assert.equal(normalizeOrder('3'), 3)
  assert.equal(normalizeOrder(2.9), 2)
})

test('buildKillChainPhaseInput always sends x_opencti_order as a number', () => {
  const input = buildKillChainPhaseInput({ kill_chain_name: 'mitre-attack', phase_name: 'reconnaissance' })
  assert.deepEqual(input, { kill_chain_name: 'mitre-attack', phase_name: 'reconnaissance', x_opencti_order: 0 })

  const full = buildKillChainPhaseInput(good)
  assert.equal(full.x_opencti_order, 1)
  assert.equal(typeof full.x_opencti_order, 'number')
})

test('buildKillChainPhasePatch sends a native number, never a string, and never patches the identity', () => {
  const patch = buildKillChainPhasePatch(good)
  assert.ok(patch.every((p) => p.key !== 'kill_chain_name' && p.key !== 'phase_name'))
  const order = patch.find((p) => p.key === 'x_opencti_order')
  assert.deepEqual(order?.value, [1])
  assert.equal(typeof order?.value[0], 'number')
})

test('killChainPhasesFromList unwraps the edges/node connection', () => {
  const list = killChainPhasesFromList({
    killChainPhases: {
      edges: [
        { node: { id: '1', kill_chain_name: 'mitre-attack', phase_name: 'initial-access' } },
        { node: { id: '2', kill_chain_name: 'mitre-attack', phase_name: 'reconnaissance' } },
      ],
    },
  })
  assert.equal(list.length, 2)
  assert.equal(findKillChainPhase(list, 'MITRE-ATTACK', 'Initial-Access')?.id, '1')
})

test('findKillChainPhase does not collide across kill chains sharing a phase name', () => {
  const list = killChainPhasesFromList({
    killChainPhases: {
      edges: [
        { node: { id: '1', kill_chain_name: 'mitre-attack', phase_name: 'reconnaissance' } },
        { node: { id: '2', kill_chain_name: 'lockheed-martin-cyber-kill-chain', phase_name: 'reconnaissance' } },
      ],
    },
  })
  assert.equal(findKillChainPhase(list, 'mitre-attack', 'reconnaissance')?.id, '1')
  assert.equal(findKillChainPhase(list, 'lockheed-martin-cyber-kill-chain', 'reconnaissance')?.id, '2')
  assert.equal(findKillChainPhase(list, 'some-other-chain', 'reconnaissance'), null)
})
