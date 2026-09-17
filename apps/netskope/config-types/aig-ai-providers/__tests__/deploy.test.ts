// deploy for aig-ai-providers.
//
// The shared contracts cover the refusals, the create/update split and the prior
// state recorded for an update. What is specific here is the TLS certificate: it
// is write-only (the API never returns it), so it must reach the vendor in the
// body and must never reach rollbackData, where it would be stored in the
// platform's deployment record in clear.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  bodyOf,
  created,
  deployContext,
  item,
  leaks,
  list,
  ok,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudDeployContract,
  registerDeployGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/aig/aiproviders'
const BASE_RE = /\/aig\/aiproviders/

/** Distinctive on purpose — a certificate in rollbackData has leaked. */
const CERTIFICATE = '-----BEGIN CERTIFICATE-----MUST-NOT-BE-STORED-----END CERTIFICATE-----'

const provider = (name: string) =>
  item(name, { name, schema: 'openai', host: 'api.openai.test', port: 443, protocol: 'https', certificate: CERTIFICATE })

/** The same provider as the TENANT holds it — a different host, port, protocol
 *  and schema, so a recorded "prior" built from the canvas is caught. */
const liveProvider = (name: string, id: string) => ({
  provider_id: id,
  name,
  schema: 'azureopenai',
  host: 'legacy.internal',
  port: 8443,
  protocol: 'http',
})

registerDeployGuardContract({
  label: 'aig-ai-providers',
  handler: deploy,
  items: [provider('veltrix-alpha')],
  listPath: BASE,
})

registerCrudDeployContract({
  label: 'aig-ai-providers',
  handler: deploy,
  basePath: BASE,
  createEnvelope: 'bare',
  updateMethod: 'PUT',
  item: provider,
  live: liveProvider,
  createdBody: (name, id) => ({ provider_id: id, name }),
  assertPrior: (prior) => {
    assert.equal(prior.host, 'legacy.internal', 'the recorded prior must be the LIVE host')
    assert.equal(prior.port, 8443)
    assert.equal(prior.protocol, 'http')
    assert.equal(prior.schema, 'azureopenai')
    assert.equal(leaks(prior, CERTIFICATE), false, 'the write-only certificate must never be recorded')
  },
  assertCreateBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.schema, 'openai')
    assert.equal(body.host, 'api.openai.test')
    assert.equal(body.port, 443)
    assert.equal(body.protocol, 'https')
    assert.equal(body.certificate, CERTIFICATE, 'the certificate is write-only, so it must be sent on every write')
  },
})

test('aig-ai-providers deploy: never puts the certificate in the result it hands the platform', async () => {
  const { restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([liveProvider('veltrix-alpha', '4102')]) },
    { url: BASE_RE, method: 'PUT', respond: ok({ provider_id: '4102' }) },
  ])
  try {
    const result = await deploy(deployContext([provider('veltrix-alpha')]))

    assert.equal(result.success, true, result.message)
    assert.equal(leaks(result, CERTIFICATE), false, 'rollbackData and the message must not carry the certificate')
  } finally {
    restore()
  }
})

test('aig-ai-providers deploy: omits the certificate when none is declared', async () => {
  const { calls, restore } = routeFetch([
    { url: BASE_RE, method: 'GET', respond: list([]) },
    { url: BASE_RE, method: 'POST', respond: created({ provider_id: '9001' }) },
  ])
  try {
    await deploy(
      deployContext([item('veltrix-alpha', { name: 'veltrix-alpha', schema: 'openai', host: 'h.test', port: 443, protocol: 'https' })]),
    )

    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal('certificate' in body, false, 'no certificate declared means the key is not sent at all')
  } finally {
    restore()
  }
})
