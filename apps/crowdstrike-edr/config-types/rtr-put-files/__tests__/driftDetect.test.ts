// driftDetect for rtr-put-files.
//
// The shared contract covers the invariants: drift never writes, a deleted
// put-file is critical drift, and a 500 is never reported as the file being
// gone. What is specific here is that the API NEVER returns a put-file's bytes,
// so content can only be compared through the live `sha256` — and the diff must
// summarise the mismatch rather than echo the staged payload.
//
// NOT ASSERTED, deliberately: what this handler returns when the live put-file
// carries no `sha256` at all. It skips the content comparison entirely and the
// run comes back `hasDrift: false` with no `checked: false`, which the platform
// reads as a positive "I checked the bytes and they match". Asserting the
// current behaviour would bless that; it is in the accompanying report instead.

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

const FILE_CONTENT = '# staged isolation payload\nStop-Service -Name RemoteRegistry\n'

const PUT_FILE = item('Isolation payload', {
  name: 'isolate-host.ps1',
  description: 'Staged isolation payload',
  content: FILE_CONTENT,
})

registerDriftContract({ label: 'rtr-put-files', handler: driftDetect, items: [PUT_FILE] })

/** SHA-256 of a UTF-8 string, computed independently of the handler. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** The live put-file exactly matching the canvas, overridable field by field. */
async function live(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    id: 'pf-live-1',
    name: 'isolate-host.ps1',
    description: 'Staged isolation payload',
    sha256: await sha256Hex(FILE_CONTENT),
    ...over,
  }
}

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('rtr-put-files driftDetect: reports no drift when the staged bytes still hash the same', async () => {
  const { calls, restore } = recordFetch(lookup(await live()))
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    assert.equal(result.hasDrift, false, `unexpected diffs: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: reports a put-file whose bytes were replaced in the console', async () => {
  const { restore } = recordFetch(
    lookup(await live({ sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' })),
  )
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'isolate-host.ps1.content')
    assert.ok(diff, `expected a content diff, got ${JSON.stringify(result.diffs)}`)
    assert.match(String(diff.actual), /sha256 mismatch/)
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: never echoes the staged payload into a diff', async () => {
  // Drift records are stored and surfaced widely; a file staged for RTR is not
  // something to copy into one.
  const { restore } = recordFetch(
    lookup(await live({ sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' })),
  )
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    assert.equal(
      JSON.stringify(result.diffs).includes('Stop-Service'),
      false,
      'the file content leaked into a diff',
    )
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: reports a description edited in the console as informational', async () => {
  const { restore } = recordFetch(lookup(await live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    const diff = result.diffs.find((d) => d.field === 'isolate-host.ps1.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'info')
    assert.equal(diff.actual, 'edited by hand')
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(
      await live({
        sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    const diff = result.diffs.find((d) => d.field === 'isolate-host.ps1.content')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookup(
      await live({
        sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        modified_by: CLIENT_ID,
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([PUT_FILE]))

    const diff = result.diffs.find((d) => d.field === 'isolate-host.ps1.content')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('rtr-put-files driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Isolation payload', {
    name: 'isolate-host.ps1',
    description: 'Staged isolation payload',
    content: '# a newer payload nobody has deployed yet\n',
  })
  const { restore } = recordFetch(lookup(await live()))
  try {
    const result = await driftDetect(driftContext([PUT_FILE], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
