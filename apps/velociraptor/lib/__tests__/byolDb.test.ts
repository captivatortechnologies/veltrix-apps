import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createByol, updateByol, type ByolInput } from '../db/byol'

// =============================================================================
// This app is node_tiers-native: the generic per-tier `node_tiers` column is
// the ONLY node-count storage. createByol / updateByol must write it — from the
// caller's `nodeTiers` when given, and default to an empty list when absent —
// into the app-owned velociraptor_byol_infrastructure table.
// =============================================================================

interface Captured {
  sql: string
  args: unknown[]
}

/** A minimal db double that records $queryRawUnsafe calls and returns a fake row. */
function fakeDb() {
  const calls: Captured[] = []
  const row: Record<string, unknown> = {
    id: 'i1',
    name: 'Prod',
    deployment_type: 'distributed',
    environment_type: 'prod',
    status: 'not_started',
    customer_id: 'cust-1',
    cloud_provider_id: 'cp-aws',
    hosting_type: 'AWS',
    region: 'us-east-1',
    network_mode: 'shared',
    dns_mode: 'managed',
    cloud_account_connection_id: null,
    control_plane_layout: 'dedicated',
    instance_type: null,
    node_tiers: '[]',
    created_at: new Date(),
    updated_at: new Date(),
  }
  const db = {
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args })
      return Promise.resolve([row])
    },
    $executeRawUnsafe: () => Promise.resolve(1), // usage/state event
  } as any
  return { db, calls }
}

const baseInput: ByolInput = {
  name: 'Prod',
  deploymentType: 'distributed',
  environmentType: 'prod',
  hosting_type: 'AWS',
  region: 'us-east-1',
  cloudProviderId: 'cp-aws',
}

test('createByol writes the caller-supplied nodeTiers verbatim', async () => {
  const { db, calls } = fakeDb()
  await createByol(db, 'cust-1', {
    ...baseInput,
    nodeTiers: [
      { key: 'frontend', count: 3, placement: null },
      { key: 'datastore', count: 2, placement: null },
    ],
  })

  const insert = calls.find((c) => c.sql.includes('INSERT INTO velociraptor_byol_infrastructure'))
  assert.ok(insert)
  assert.match(insert!.sql, /node_tiers/)
  const nodeTiersArg = insert!.args[insert!.args.length - 1] as string
  assert.deepEqual(JSON.parse(nodeTiersArg), [
    { key: 'frontend', count: 3, placement: null },
    { key: 'datastore', count: 2, placement: null },
  ])
})

test('createByol defaults node_tiers to an empty list when nodeTiers is absent', async () => {
  const { db, calls } = fakeDb()
  await createByol(db, 'cust-1', baseInput)

  const insert = calls.find((c) => c.sql.includes('INSERT INTO velociraptor_byol_infrastructure'))
  const nodeTiersArg = insert!.args[insert!.args.length - 1] as string
  assert.deepEqual(JSON.parse(nodeTiersArg), [])
})

test('updateByol writes the caller-supplied nodeTiers verbatim', async () => {
  const { db, calls } = fakeDb()
  await updateByol(db, 'i1', {
    ...baseInput,
    nodeTiers: [
      { key: 'frontend', count: 5, placement: null },
      { key: 'datastore', count: 3, placement: null },
    ],
  })

  const update = calls.find((c) => c.sql.includes('UPDATE velociraptor_byol_infrastructure'))
  assert.ok(update)
  assert.match(update!.sql, /node_tiers\s*=/)
  const nodeTiersArg = update!.args[update!.args.length - 1] as string
  assert.deepEqual(JSON.parse(nodeTiersArg), [
    { key: 'frontend', count: 5, placement: null },
    { key: 'datastore', count: 3, placement: null },
  ])
})
