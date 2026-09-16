// ============================================================================
// deploy for Entra terms of use agreements, against a fake Graph.
//
// An agreement is what a Conditional Access policy makes a user accept before it
// grants access, so two things decide whether it is really enforced: that it
// exists at all, and `isViewingBeforeAcceptanceRequired` — without it a user can
// accept without ever opening the document. Graph also lets agreements be
// duplicated freely by name, so the handler's refusal to reconcile against a
// TRUNCATED listing is asserted here too: a second copy of an agreement is a
// second acceptance record nobody is tracking.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_CONTENT,
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  collection,
  created,
  deployContext,
  graphError,
  item,
  leaksSecret,
  page,
  recordFetch,
  routeFetch,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import deploy from '../deploy'

const BASE = '/identityGovernance/termsOfUse/agreements'
/** Stand-in for the base64 PDF bytes the canvas carries. */
const PDF = 'JVBERi0xLjQKJSBmYWtlIHBkZgo='

function agreementItem(fields: Record<string, unknown> = {}) {
  return item('Acceptable Use Policy', {
    name: 'Acceptable Use Policy',
    viewingBeforeAcceptanceRequired: true,
    fileData: PDF,
    ...fields,
  })
}

/** A live agreement as the `$select` listing returns it. */
function liveAgreement(over: Record<string, unknown> = {}) {
  return {
    id: 'a-1',
    displayName: 'Acceptable Use Policy',
    isViewingBeforeAcceptanceRequired: true,
    isPerDeviceAcceptanceRequired: false,
    userReacceptRequiredFrequency: null,
    termsExpiration: null,
    ...over,
  }
}

test('deploy refuses without a credential instead of calling Graph', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([agreementItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('deploy refuses when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([agreementItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list agreements/)
    assert.match(String(result.message), /Insufficient privileges/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a TRUNCATED listing stops the deploy rather than risk a duplicate agreement', async () => {
  // Agreements reconcile by display name and Graph happily allows two with the
  // same one. If the listing did not reach the end, "not found" cannot be
  // distinguished from "on a page we never fetched", and a create would add a
  // second copy users would be asked to accept separately.
  const { calls, restore } = routeFetch([
    {
      url: /identityGovernance\/termsOfUse\/agreements/,
      // The nextLink matches this same route, so the fake keeps paging until the
      // client's page budget runs out and it reports truncated.
      respond: page([], 'https://graph.microsoft.com/v1.0/identityGovernance/termsOfUse/agreements?$skiptoken=more'),
    },
  ])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Cannot safely reconcile terms-of-use agreements/)
    assert.match(String(result.message), /truncated/)
    assert.equal(writeCalls(calls).length, 0)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('deploy authenticates first and creates an agreement with its PDF attached', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'a-new' })])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)
    assert.equal(graphCalls[0].method, 'GET')

    assert.equal(graphCalls[1].method, 'POST')
    assert.ok(graphCalls[1].url.endsWith(BASE), `POST target was ${graphCalls[1].url}`)
    assert.deepEqual(bodyOf(graphCalls[1]), {
      displayName: 'Acceptable Use Policy',
      // Without this the user can accept a document they never opened.
      isViewingBeforeAcceptanceRequired: true,
      isPerDeviceAcceptanceRequired: false,
      files: [
        {
          fileName: 'agreement.pdf',
          displayName: 'Acceptable Use Policy',
          language: 'en',
          isDefault: true,
          isMajorVersion: true,
          fileData: { data: PDF },
        },
      ],
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 'a-new')
    assert.equal(result.success, true)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('viewing before acceptance is sent false when the canvas does not require it', async () => {
  // An absent flag must not be read as "required" either — the body has to say
  // exactly what the canvas said, in both directions.
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'a-new' })])
  try {
    await deploy(deployContext([agreementItem({ viewingBeforeAcceptanceRequired: false })]))

    assert.equal(bodyOf(writeCalls(calls)[0])?.isViewingBeforeAcceptanceRequired, false)
  } finally {
    restore()
  }
})

test('the re-accept frequency and expiration schedule are sent only when the canvas sets them', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'a-new' })])
  try {
    await deploy(
      deployContext([
        agreementItem({
          reacceptFrequency: 'P365D',
          expirationStartDate: '2026-01-01T00:00:00Z',
          expirationFrequency: 'P365D',
          fileName: 'aup-2026.pdf',
          fileLanguage: 'en-GB',
        }),
      ]),
    )

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal(body?.userReacceptRequiredFrequency, 'P365D')
    assert.deepEqual(body?.termsExpiration, { startDateTime: '2026-01-01T00:00:00Z', frequency: 'P365D' })
    assert.deepEqual((body?.files as Array<Record<string, unknown>>)[0].fileName, 'aup-2026.pdf')
    assert.deepEqual((body?.files as Array<Record<string, unknown>>)[0].language, 'en-GB')
  } finally {
    restore()
  }
})

test('an incomplete expiration pair is omitted entirely rather than half-sent', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), created({ id: 'a-new' })])
  try {
    await deploy(deployContext([agreementItem({ expirationStartDate: '2026-01-01T00:00:00Z' })]))

    const body = bodyOf(writeCalls(calls)[0])
    assert.equal('termsExpiration' in (body ?? {}), false)
    assert.equal('userReacceptRequiredFrequency' in (body ?? {}), false)
  } finally {
    restore()
  }
})

test('deploy updates an existing agreement and records its LIVE prior metadata', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveAgreement({ isViewingBeforeAcceptanceRequired: true })]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(deployContext([agreementItem({ viewingBeforeAcceptanceRequired: false })]))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH')
    assert.ok(writes[0].url.endsWith(`${BASE}/a-1`))
    // Graph v1.0 can only patch these two fields; the PDF is create-only, so it
    // must NOT be smuggled into the update.
    assert.deepEqual(bodyOf(writes[0]), {
      displayName: 'Acceptable Use Policy',
      isViewingBeforeAcceptanceRequired: false,
    })

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
    assert.equal(entries[0].id, 'a-1')
    assert.deepEqual(entries[0].prior, {
      displayName: 'Acceptable Use Policy',
      isViewingBeforeAcceptanceRequired: true,
    })
    assert.notDeepEqual(entries[0].prior, bodyOf(writes[0]), 'the prior must be the live state, not the desired one')
  } finally {
    restore()
  }
})

test('an agreement this app created keeps existed:false across later deploys', async () => {
  // Provenance is sticky on purpose: re-deriving it would flip to true after the
  // first update and the agreement would be orphaned instead of cleaned up.
  const { restore } = recordFetch([TOKEN, collection([liveAgreement()]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([agreementItem()], {
        priorRollbackData: { entries: [{ name: 'Acceptable Use Policy', existed: false, id: 'a-1' }] },
      }),
    )

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, false)
  } finally {
    restore()
  }
})

test('an agreement the tenant already had is recorded as pre-existing', async () => {
  const { restore } = recordFetch([TOKEN, collection([liveAgreement()]), NO_CONTENT])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries[0].existed, true)
  } finally {
    restore()
  }
})

test('a create with no PDF fails that agreement WITHOUT a partial write', async () => {
  // Graph requires a file to create an agreement; emitting the POST anyway would
  // be a guaranteed rejection, and an empty-file agreement is worse than none.
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([agreementItem({ fileData: '' })]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /PDF content \(base64\) is required to create a new agreement/)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('an agreement renamed in the portal is matched by its recorded id, not duplicated', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    collection([liveAgreement({ displayName: 'Renamed in the portal' })]),
    NO_CONTENT,
  ])
  try {
    const result = await deploy(
      deployContext([agreementItem()], {
        priorRollbackData: { entries: [{ name: 'Acceptable Use Policy', existed: true, id: 'a-1', prior: {} }] },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'PATCH', 'a rename must not become a second agreement')
    assert.ok(writes[0].url.endsWith(`${BASE}/a-1`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('an item with no name is skipped — nothing is written for it', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([])])
  try {
    const result = await deploy(deployContext([item('', { fileData: PDF })]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(result.rollbackData, { entries: [] })
  } finally {
    restore()
  }
})

test('deploy reports a rejected create rather than throwing', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    graphError(400, 'The uploaded file is not a valid PDF.', 'Request_BadRequest'),
  ])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Some agreements failed/)
    assert.match(String(result.message), /Acceptable Use Policy: .*not a valid PDF/)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a failure on one agreement still records rollback state for the one that landed', async () => {
  const { restore } = recordFetch([
    TOKEN,
    collection([]),
    created({ id: 'a-new' }),
    graphError(403, 'Insufficient privileges to complete the operation.'),
  ])
  try {
    const result = await deploy(
      deployContext([agreementItem(), agreementItem({ name: 'Contractor Terms' })]),
    )

    assert.equal(result.success, false)
    const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'a-new')
  } finally {
    restore()
  }
})

test('reconcile deletes an agreement this app created and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, collection([]), NO_CONTENT])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: { entries: [{ name: 'Retired Terms', existed: false, id: 'a-old' }] },
      }),
    )

    const deletes = writeCalls(calls).filter((c) => c.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.ok(deletes[0].url.endsWith(`${BASE}/a-old`))
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('reconcile leaves an agreement that pre-existed this app alone', async () => {
  // Deleting it would destroy every acceptance record attached to it.
  const { calls, restore } = recordFetch([TOKEN, collection([liveAgreement({ id: 'a-keep' })])])
  try {
    const result = await deploy(
      deployContext([], {
        priorRollbackData: {
          entries: [
            { name: 'Legacy Terms', existed: true, id: 'a-keep', prior: { displayName: 'Legacy Terms' } },
          ],
        },
      }),
    )

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('a rejected token exchange stops the deploy without a single Graph call', async () => {
  const { calls, restore } = recordFetch([
    { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' } },
  ])
  try {
    const result = await deploy(deployContext([agreementItem()]))

    assert.equal(result.success, false)
    assert.equal(vendorCalls(calls).length, 0, 'no Graph request may be attempted without a token')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})
