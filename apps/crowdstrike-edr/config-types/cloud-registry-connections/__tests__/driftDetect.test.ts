// driftDetect for cloud-registry-connections.
//
// The shared contract covers the invariants: drift never writes, a removed
// registry is critical drift, and a 500 is never reported as the registry being
// gone. What is specific here is that the comparison is deliberately PARTIAL:
// the credential is write-only, so it is never read back and never diffed. A
// diff is persisted and displayed, so the assertions below check not only what
// is reported but that the secret is absent from everything that is.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

/** See deploy.test.ts — the shared fake models Falcon's secrets, not a registry's. */
const REGISTRY_SECRET = 'registry-password-MUST-NOT-LEAK'

function leaksRegistrySecret(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(REGISTRY_SECRET)
}

const REGISTRY = item('Production Harbor', {
  name: 'prod-harbor',
  url: 'harbor.acme.internal',
  type: 'harbor',
  username: 'veltrix-scanner',
  credential: REGISTRY_SECRET,
  scanInterval: 24,
  enabled: true,
})

registerDriftContract({
  label: 'cloud-registry-connections',
  handler: driftDetect,
  items: [REGISTRY],
})

/** The live registry exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'reg-live-1',
  user_defined_alias: 'prod-harbor',
  url: 'harbor.acme.internal',
  type: 'harbor',
  state: 'active',
  scan_interval: 24,
  ...over,
})

/** One listing serves every declared registry: id query, then get. */
function listing(registries: Array<Record<string, unknown>>) {
  return registries.length === 0
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage(registries.map((r) => String(r.id))), entityPage(registries)]
}

test('cloud-registry-connections driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(listing([live()]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reports a registry re-pointed at another host', async () => {
  const { restore } = recordFetch(listing([live({ url: 'harbor-evil.acme.internal' })]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'prod-harbor.url')
    assert.ok(diff, `expected a url diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'harbor.acme.internal')
    assert.equal(diff.actual, 'harbor-evil.acme.internal')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reports a changed provider type', async () => {
  const { restore } = recordFetch(listing([live({ type: 'artifactory' })]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    const diff = result.diffs.find((d) => d.field === 'prod-harbor.type')
    assert.ok(diff, `expected a type diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'artifactory')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reports a registry paused in the console', async () => {
  // A paused registry stops being scanned. Nothing else surfaces that — the
  // vulnerability findings simply stop arriving.
  const { restore } = recordFetch(listing([live({ state: 'paused' })]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    const diff = result.diffs.find((d) => d.field === 'prod-harbor.enabled')
    assert.ok(diff, `expected an enabled diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'active')
    assert.equal(diff.actual, 'paused')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reports a scan interval stretched in the console', async () => {
  const { restore } = recordFetch(listing([live({ scan_interval: 168 })]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    const diff = result.diffs.find((d) => d.field === 'prod-harbor.scanInterval')
    assert.ok(diff, `expected a scanInterval diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 24)
    assert.equal(diff.actual, 168)
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: leaves the scan settings alone when the API omits them', async () => {
  // `state` and `scan_interval` are best-effort fields. A live entity that does
  // not report them must not drift against a value that was never readable.
  const { restore } = recordFetch(
    listing([{ id: 'reg-live-1', user_defined_alias: 'prod-harbor', url: 'harbor.acme.internal', type: 'harbor' }]),
  )
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: never compares or reports the registry credential', async () => {
  // The secret is write-only. Even when everything else drifts, no diff may
  // carry it and no diff may claim the credential itself changed.
  const { restore } = recordFetch(
    listing([live({ url: 'harbor-evil.acme.internal', type: 'artifactory', state: 'paused' })]),
  )
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    assert.equal(result.hasDrift, true)
    assert.equal(leaksRegistrySecret(result), false, 'a diff carried the registry credential')
    assert.equal(
      result.diffs.some((d) => /credential|password|username/i.test(String(d.field))),
      false,
      `a write-only secret must not be diffed: ${JSON.stringify(result.diffs.map((d) => d.field))}`,
    )
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: matches by alias, case-insensitively', async () => {
  const { restore } = recordFetch(listing([live({ user_defined_alias: 'PROD-HARBOR' })]))
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    assert.equal(
      result.diffs.some((d) => d.actual === 'missing'),
      false,
      'an alias differing only in case is the same registry',
    )
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reads the whole list once for many registries', async () => {
  // The collection has no name filter, so a per-registry query would be both
  // wrong and slow; one listing must serve every declared registry.
  const second = item('Lab registry', {
    name: 'lab-quay',
    url: 'quay.lab.acme.internal',
    type: 'quay',
    credential: REGISTRY_SECRET,
  })
  const { calls, restore } = recordFetch(
    listing([
      live(),
      { id: 'reg-live-2', user_defined_alias: 'lab-quay', url: 'quay.lab.acme.internal', type: 'quay' },
    ]),
  )
  try {
    const result = await driftDetect(driftContext([REGISTRY, second]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.equal(
      calls.filter((c) => c.url.includes('/queries/registries/')).length,
      1,
      `expected a single listing, got ${calls.length} calls`,
    )
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    listing([
      live({
        url: 'harbor-old.acme.internal',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ]),
  )
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    const diff = result.diffs.find((d) => d.field === 'prod-harbor.url')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: does not attribute drift to our own API client', async () => {
  const { restore } = recordFetch(
    listing([live({ url: 'harbor-old.acme.internal', modified_by: CLIENT_ID })]),
  )
  try {
    const result = await driftDetect(driftContext([REGISTRY]))

    const diff = result.diffs.find((d) => d.field === 'prod-harbor.url')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('cloud-registry-connections driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // An edit the operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Production Harbor', {
    name: 'prod-harbor',
    url: 'harbor-next.acme.internal',
    type: 'harbor',
    credential: REGISTRY_SECRET,
    scanInterval: 24,
    enabled: true,
  })
  const { restore } = recordFetch(listing([live()]))
  try {
    const result = await driftDetect(driftContext([REGISTRY], { canvasItems: [edited] }))

    assert.equal(
      result.hasDrift,
      false,
      `compared against the canvas: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})
