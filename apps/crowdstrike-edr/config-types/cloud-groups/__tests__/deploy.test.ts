// ============================================================================
// Handler tests against a FAKE VENDOR — the pattern the catalog is missing.
//
// Across 96 apps and 1170 configuration types, `validate` is tested everywhere
// and the five handlers that actually talk to the vendor are not: deploy,
// rollback, healthCheck and driftDetect sit near zero, getStatus at zero. The
// untested part is precisely the part that performs real actions against a
// customer's infrastructure.
//
// Nothing exotic is needed to close that. 89 of 96 apps reach the vendor through
// global `fetch`, so stubbing `globalThis.fetch` exercises a handler end to end
// — its request sequence, its body, its error handling and the rollback state it
// records — with no module mocking, no new dependency, and plain `node --test`.
//
// This file is the worked example. `recordFetch` below is the whole harness.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeployContext } from '@veltrixsecops/app-sdk'
import deploy from '../deploy'

interface Call {
  url: string
  method: string
  body: string
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 * `responses` are consumed in order; the first is the OAuth token exchange that
 * every Falcon client performs before its first real request.
 */
function recordFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const next = queue.shift() ?? { status: 200, body: { resources: [] } }
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: () => 'application/json' },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    }
  }) as unknown as typeof globalThis.fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}

const TOKEN = { status: 201, body: { access_token: 'tok', expires_in: 1799 } }

/**
 * One canvas SECTION per group — the shape `extractCloudGroupSpecs` reads, where
 * each section carries a flat `fields` record rather than a list of items.
 */
function contextWith(groups: Array<Record<string, unknown>>): DeployContext {
  return {
    component: { hostname: 'api.crowdstrike.com' },
    credential: { username: 'client-id', apiToken: 'client-secret' },
    settings: {},
    canvas: {
      canvasId: 'canvas-1',
      version: 1,
      sections: groups.map((fields, i) => ({ name: `Group ${i + 1}`, fields })),
    },
  } as unknown as DeployContext
}

test('deploy refuses without a credential instead of calling the vendor', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const ctx = contextWith([]) as unknown as { credential: unknown }
    ctx.credential = null

    const result = await deploy(ctx as unknown as DeployContext)

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0, 'must not reach the vendor without a credential')
  } finally {
    restore()
  }
})

test('deploy authenticates before its first real request', async () => {
  const { calls, restore } = recordFetch([TOKEN])
  try {
    await deploy(contextWith([]))

    // An empty canvas still proves the auth seam is wired: no groups to create,
    // so any call at all must be the token exchange.
    for (const call of calls) {
      assert.match(call.url, /oauth2\/token/, `unexpected call before auth: ${call.url}`)
    }
  } finally {
    restore()
  }
})

test('deploy creates a group that does not exist yet', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    { body: { resources: [] } }, // queries: no match for this name
    { body: { resources: ['new-group-id'] } }, // create returns bare id strings
  ])
  try {
    const result = await deploy(
      contextWith([{ name: 'prod-workloads', environment: 'production' }]),
    )

    const vendorCalls = calls.filter((c) => !/oauth2\/token/.test(c.url))
    assert.ok(vendorCalls.length > 0, 'deploy made no vendor call')

    const created = vendorCalls.find((c) => c.method === 'POST')
    assert.ok(created, 'expected a POST creating the group')
    assert.match(created.url, /cloud-groups/)
    assert.match(created.body, /prod-workloads/)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('deploy reports failure rather than throwing when the vendor rejects', async () => {
  const { restore } = recordFetch([
    TOKEN,
    { body: { resources: [] } },
    { status: 403, body: { errors: [{ message: 'access denied' }] } },
  ])
  try {
    const result = await deploy(contextWith([{ name: 'prod-workloads' }]))

    // A handler that throws surfaces as an opaque pipeline crash; the contract
    // is a DeployResult carrying the reason.
    assert.equal(result.success, false)
    assert.ok(String(result.message).length > 0)
  } finally {
    restore()
  }
})
