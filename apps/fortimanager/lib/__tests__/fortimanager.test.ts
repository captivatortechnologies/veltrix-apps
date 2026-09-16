// =============================================================================
// The FortiManager JSON-RPC client every handler in this app goes through.
//
// The 32 handler contract suites assert what each handler does with the client's
// ANSWERS. This file asserts the client itself: that it logs in once and reuses
// the session, that it re-logs in exactly once on the code FortiManager uses for
// an expired session, that a rejection inside a 200 is not mistaken for success,
// and that a dead socket becomes a returned error rather than a throw.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialRef } from '@veltrixsecops/app-sdk'
import {
  FmgClient,
  addressUrl,
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
} from '../fortimanager'
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  BASE_URL,
  ENDPOINT,
  LOGIN_OK,
  SESSION,
  httpError,
  isLogin,
  isLogout,
  loginFailure,
  rpcError,
  rpcOk,
  withFmg,
  withUnreachableFmg,
} from './fakeFmg'

const CRED = { baseUrl: BASE_URL, user: ADMIN_USER, passwd: ADMIN_PASSWORD }

function credentialRef(over: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'FortiManager admin',
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    apiToken: null,
    certificate: null,
    ...over,
  }
}

function client(timeoutMs = 30_000): FmgClient {
  return new FmgClient({ cred: CRED, timeoutMs })
}

// --- settings -----------------------------------------------------------------

test('readFmgSettings defaults the ADOM to root and leaves workspace mode off', () => {
  const settings = readFmgSettings({ host: 'fmg.example.com' })

  assert.equal(settings.adom, 'root')
  assert.equal(settings.workspaceMode, false)
  assert.equal(settings.timeoutMs, 30_000)
})

test('readFmgSettings assumes https and trims a trailing slash from the host', () => {
  assert.equal(readFmgSettings({ host: 'fmg.example.com' }).baseUrl, 'https://fmg.example.com')
  assert.equal(readFmgSettings({ host: 'fmg.example.com/' }).baseUrl, 'https://fmg.example.com')
  assert.equal(readFmgSettings({ host: 'https://fmg.example.com//' }).baseUrl, 'https://fmg.example.com')
  assert.equal(readFmgSettings({ host: 'http://fmg.internal' }).baseUrl, 'http://fmg.internal')
})

test('readFmgSettings leaves the base URL null when no host is configured', () => {
  assert.equal(readFmgSettings({}).baseUrl, null)
  assert.equal(readFmgSettings({ host: '   ' }).baseUrl, null)
})

test('readFmgSettings reads the request timeout in seconds', () => {
  assert.equal(readFmgSettings({ host: 'h', request_timeout_seconds: 5 }).timeoutMs, 5000)
  // A nonsense timeout falls back to the default rather than aborting instantly.
  assert.equal(readFmgSettings({ host: 'h', request_timeout_seconds: 0 }).timeoutMs, 30_000)
  assert.equal(readFmgSettings({ host: 'h', request_timeout_seconds: -1 }).timeoutMs, 30_000)
})

test('resolveFmgCredential refuses anything it cannot log in with', () => {
  const settings = readFmgSettings({ host: 'fmg.example.com' })

  assert.equal(resolveFmgCredential(null, settings), null)
  assert.equal(resolveFmgCredential(credentialRef({ username: '' }), settings), null)
  assert.equal(resolveFmgCredential(credentialRef({ password: '' }), settings), null)
  assert.equal(resolveFmgCredential(credentialRef(), readFmgSettings({})), null)

  assert.deepEqual(resolveFmgCredential(credentialRef(), settings), {
    baseUrl: 'https://fmg.example.com',
    user: ADMIN_USER,
    passwd: ADMIN_PASSWORD,
  })
})

test('addressUrl scopes the object path to the ADOM', () => {
  assert.equal(addressUrl('customer-a'), '/pm/config/adom/customer-a/obj/firewall/address')
})

test('buildFmgClient posts to the configured host’s JSON-RPC endpoint', async () => {
  const built = buildFmgClient(CRED, readFmgSettings({ host: 'fmg.example.com' }))

  await withFmg([LOGIN_OK, rpcOk([])], async (calls) => {
    await built.get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(calls[0].url, ENDPOINT)
    assert.equal(calls[1].url, ENDPOINT)
  })
})

test('a request that never answers is aborted at the configured timeout', async () => {
  // Without this the pipeline would hang on an unresponsive FortiManager for as
  // long as the platform's own deadline, with no message to show for it.
  const original = globalThis.fetch
  globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
    })) as unknown as typeof globalThis.fetch
  try {
    const res = await client(10).get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(res.ok, false)
    assert.match(String(res.transportError), /abort/i)
  } finally {
    globalThis.fetch = original
  }
})

// --- session ------------------------------------------------------------------

test('the client logs in once and reuses the session for every later call', async () => {
  await withFmg([LOGIN_OK, rpcOk([]), rpcOk(), rpcOk()], async (calls) => {
    const c = client()
    await c.get('/pm/config/adom/root/obj/firewall/address')
    await c.set('/pm/config/adom/root/obj/firewall/address', { name: 'a' })
    await c.logout()

    assert.equal(calls.filter(isLogin).length, 1, 'one client instance means one login')
    assert.equal(calls[1].session, SESSION)
    assert.equal(calls[2].session, SESSION)
    assert.ok(isLogout(calls[3]))
  })
})

test('logout does nothing when the client never logged in', async () => {
  await withFmg([], async (calls) => {
    await client().logout()

    assert.equal(calls.length, 0)
  })
})

test('a rejected login stops the call and reports why', async () => {
  await withFmg([loginFailure('Login fail: wrong password')], async (calls) => {
    const res = await client().get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(res.ok, false)
    assert.match(res.message, /Login fail: wrong password/)
    assert.equal(calls.length, 1, 'the real request must not be attempted unauthenticated')
    assert.equal(res.message.includes(ADMIN_PASSWORD), false)
  })
})

test('a -11 is treated as an expired session: re-login once, then retry', async () => {
  const relogin = { status: 200, body: { id: 1, session: 'second-session', result: [{ status: { code: 0 } }] } }
  await withFmg([LOGIN_OK, rpcError('no permission for the resource', -11), relogin, rpcOk([{ name: 'a' }])], async (calls) => {
    const res = await client().get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(res.ok, true)
    assert.deepEqual(res.data, [{ name: 'a' }])
    assert.equal(calls.filter(isLogin).length, 2)
    assert.equal(calls[3].session, 'second-session', 'the retry carries the NEW session')
  })
})

test('a -11 that survives the re-login is returned as a failure, not retried forever', async () => {
  const relogin = { status: 200, body: { id: 1, session: 'second-session', result: [{ status: { code: 0 } }] } }
  await withFmg(
    [LOGIN_OK, rpcError('no permission for the resource', -11), relogin, rpcError('no permission for the resource', -11)],
    async (calls) => {
      const res = await client().get('/pm/config/adom/root/obj/firewall/address')

      assert.equal(res.ok, false)
      assert.equal(res.code, -11)
      assert.equal(calls.length, 4, 'exactly one re-login and one retry')
    },
  )
})

// --- outcomes -----------------------------------------------------------------

test('a non-zero status code inside a 200 is a failure', async () => {
  await withFmg([LOGIN_OK, rpcError('object check and operation error', -3)], async () => {
    const res = await client().set('/pm/config/adom/root/obj/firewall/address', { name: 'a' })

    assert.equal(res.ok, false)
    assert.equal(res.code, -3)
    assert.equal(fmgErrorMessage(res), 'object check and operation error (code -3)')
  })
})

test('an HTTP-level failure with no JSON-RPC envelope is a failure, not an empty success', async () => {
  await withFmg([LOGIN_OK, httpError(502, '<html>Bad Gateway</html>')], async () => {
    const res = await client().get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(res.ok, false)
    assert.equal(res.data, undefined, 'an unparseable body must not become an empty list')
  })
})

test('an unreachable FortiManager returns a transport error rather than throwing', async () => {
  await withUnreachableFmg(async () => {
    const res = await client().get('/pm/config/adom/root/obj/firewall/address')

    assert.equal(res.ok, false)
    assert.match(String(res.transportError), /ECONNREFUSED/)
    assert.equal(fmgErrorMessage(res), res.transportError)
  })
})

// --- request shapes -----------------------------------------------------------

test('delete sends the mkey filter with the force option FortiManager needs', async () => {
  await withFmg([LOGIN_OK, rpcOk()], async (calls) => {
    await client().delete('/pm/config/adom/root/obj/firewall/address', ['name', '==', 'dmz-servers'])

    assert.equal(calls[1].rpcMethod, 'delete')
    assert.deepEqual(calls[1].filter, ['name', '==', 'dmz-servers'])
    assert.equal(calls[1].option, 'force')
  })
})

test('get omits the filter key entirely when no filter was given', async () => {
  await withFmg([LOGIN_OK, rpcOk([])], async (calls) => {
    await client().get('/pm/config/adom/root/obj/firewall/address')

    const params = (JSON.parse(calls[1].body) as { params: Array<Record<string, unknown>> }).params[0]
    assert.equal('filter' in params, false, 'a `filter: undefined` key changes how FortiManager reads the request')
  })
})

test('the workspace transaction targets the ADOM it was given', async () => {
  await withFmg([LOGIN_OK, rpcOk(), rpcOk(), rpcOk()], async (calls) => {
    const c = client()
    await c.lock('customer-a')
    await c.commit('customer-a')
    await c.unlock('customer-a')

    assert.deepEqual(
      calls.slice(1).map((call) => call.rpcUrl),
      [
        '/dvmdb/adom/customer-a/workspace/lock',
        '/dvmdb/adom/customer-a/workspace/commit',
        '/dvmdb/adom/customer-a/workspace/unlock',
      ],
    )
    for (const call of calls.slice(1)) assert.equal(call.rpcMethod, 'exec')
  })
})
