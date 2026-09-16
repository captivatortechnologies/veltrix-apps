// =============================================================================
// Keycloak User Federation — deploy / rollback / healthCheck / driftDetect /
// getStatus driven end to end against the fake Keycloak.
//
// This config type holds the LDAP bind password. Keycloak returns it on GET as
// the literal string "**********", so the rule _shared.ts sets out is the one
// that matters here: that placeholder must never be captured into rollbackData
// or merged into an update, because writing it back would replace the live
// secret with ten asterisks and break directory authentication for the realm.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import healthCheck from '../healthCheck'
import driftDetect from '../driftDetect'
import getStatus from '../getStatus'
import {
  ADMIN_BASE,
  TOKEN,
  adminPath,
  bodyOf,
  created,
  deployContext,
  driftContext,
  isTokenCall,
  item,
  kcError,
  leaksToken,
  noContent,
  notFound,
  ok,
  recordKeycloak,
  rollbackContext,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeKeycloak'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

/** The LDAP bind password an operator typed into the canvas. Write-only. */
const BIND_PASSWORD = 'ldap-bind-password-MUST-NOT-ECHO'

/** What Keycloak returns in place of a stored confidential config value. */
const MASKED = '**********'

const CORP_LDAP = {
  providerType: 'ldap',
  name: 'corp-ldap',
  enabled: true,
  priority: 0,
  editMode: 'READ_ONLY',
  vendor: 'ad',
  usernameLdapAttribute: 'sAMAccountName',
  rdnLdapAttribute: 'cn',
  uuidLdapAttribute: 'objectGUID',
  userObjectClasses: ['person', 'organizationalPerson', 'user'],
  connectionUrl: 'ldaps://dc1.corp.example.com:636',
  usersDn: 'OU=Users,DC=corp,DC=example,DC=com',
  authType: 'simple',
  bindDn: 'CN=svc-keycloak,OU=Service,DC=corp,DC=example,DC=com',
  bindCredential: BIND_PASSWORD,
  searchScope: '2',
}

const REALM = ok({ id: 'realm-uuid', realm: 'corp' })
const COMPONENTS_PATH = `/components?parentId=realm-uuid&type=org.keycloak.storage.UserStorageProvider`

/** `config` overrides MERGE into the live config; everything else replaces. */
function liveComponent(over: Record<string, unknown> = {}) {
  const { config: configOver, ...rest } = over
  return {
    id: 'component-uuid',
    name: 'corp-ldap',
    providerId: 'ldap',
    providerType: 'org.keycloak.storage.UserStorageProvider',
    parentId: 'realm-uuid',
    ...rest,
    config: {
      enabled: ['true'],
      priority: ['0'],
      editMode: ['READ_ONLY'],
      vendor: ['ad'],
      usernameLDAPAttribute: ['sAMAccountName'],
      rdnLDAPAttribute: ['cn'],
      uuidLDAPAttribute: ['objectGUID'],
      userObjectClasses: ['person, organizationalPerson, user'],
      connectionUrl: ['ldaps://dc1.corp.example.com:636'],
      usersDn: ['OU=Users,DC=corp,DC=example,DC=com'],
      authType: ['simple'],
      bindDn: ['CN=svc-keycloak,OU=Service,DC=corp,DC=example,DC=com'],
      // Keycloak never hands the real value back.
      bindCredential: [MASKED],
      searchScope: ['2'],
      importEnabled: ['true'],
      syncRegistrations: ['false'],
      pagination: ['true'],
      startTls: ['false'],
      connectionPooling: ['false'],
      batchSizeForSync: ['1000'],
      validatePasswordPolicy: ['false'],
      trustEmail: ['false'],
      usePasswordModifyExtendedOp: ['false'],
      allowKerberosAuthentication: ['false'],
      useKerberosForPasswordAuthentication: ['false'],
      debug: ['false'],
      // Keycloak-internal bookkeeping this app does not manage.
      lastSync: ['1767225600'],
      ...(configOver as Record<string, string[]> | undefined),
    },
  }
}

// --- deploy -------------------------------------------------------------------

test('user-federation deploy refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)], { credential: null }))

    assert.equal(result.success, false)
    assert.match(String(result.message), /credential/i)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('user-federation deploy stops before writing when the realm id cannot be resolved', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /could not resolve the realm internal id/)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('user-federation deploy resolves the realm id and scopes the listing to user-storage providers', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([]), created(), ok([liveComponent()])])
  try {
    await deploy(deployContext([item('ldap', CORP_LDAP)]))

    assert.ok(isTokenCall(calls[0]))
    const vendor = vendorCalls(calls)
    assert.equal(vendor[0].path, ADMIN_BASE)
    // The realm's internal id is NOT the realm name; using the name as parentId
    // would list nothing and silently create a duplicate every deploy.
    assert.equal(adminPath(vendor[1]), COMPONENTS_PATH)
  } finally {
    restore()
  }
})

test('user-federation deploy creates a provider and re-lists to capture its id', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([]), created(), ok([liveComponent()])])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET ', `GET ${COMPONENTS_PATH}`, 'POST /components', `GET ${COMPONENTS_PATH}`],
    )
    const body = bodyOf(vendor[2]) as { parentId: string; providerId: string; config: Record<string, string[]> }
    assert.equal(body.parentId, 'realm-uuid')
    assert.equal(body.providerId, 'ldap')
    // Config values are string ARRAYS on the wire, even single-valued settings.
    assert.deepEqual(body.config.connectionUrl, ['ldaps://dc1.corp.example.com:636'])
    assert.deepEqual(body.config.usernameLDAPAttribute, ['sAMAccountName'])
    assert.deepEqual(body.config.userObjectClasses, ['person, organizationalPerson, user'])
    assert.equal(result.success, true)
    assert.deepEqual((result.rollbackData as { previous: unknown[] }).previous, [
      { name: 'corp-ldap', id: 'component-uuid', component: null },
    ])
  } finally {
    restore()
  }
})

test('user-federation deploy SENDS the declared bind credential on the create', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([]), created(), ok([liveComponent()])])
  try {
    await deploy(deployContext([item('ldap', CORP_LDAP)]))

    const body = bodyOf(vendorCalls(calls)[2]) as { config: Record<string, string[]> }
    assert.deepEqual(body.config.bindCredential, [BIND_PASSWORD])
  } finally {
    restore()
  }
})

test('user-federation deploy does NOT echo the bind credential back in its result', async () => {
  const { restore } = recordKeycloak([TOKEN, REALM, ok([]), created(), ok([liveComponent()])])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)]))

    assert.equal(
      JSON.stringify(result).includes(BIND_PASSWORD),
      false,
      'the LDAP bind password escaped into the deploy message, artifacts or rollbackData',
    )
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('user-federation deploy strips the masked secret out of the prior state it records', async () => {
  const { restore } = recordKeycloak([TOKEN, REALM, ok([liveComponent()]), noContent()])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)]))

    const previous = (result.rollbackData as { previous: Array<{ component: { config: Record<string, string[]> } }> })
      .previous
    // Storing "**********" here means a later rollback would PUT it back as if
    // it were the real password.
    assert.equal(previous[0].component.config.bindCredential, undefined)
    assert.equal(JSON.stringify(result).includes(MASKED), false)
    // Everything non-secret is still captured, so a restore is still meaningful.
    assert.deepEqual(previous[0].component.config.connectionUrl, ['ldaps://dc1.corp.example.com:636'])
  } finally {
    restore()
  }
})

test('user-federation deploy never merges the masked secret into an update body', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([liveComponent()]), noContent()])
  try {
    // An operator editing the connection URL without re-typing the password.
    await deploy(
      deployContext([item('ldap', { ...CORP_LDAP, bindCredential: '', connectionUrl: 'ldaps://dc2.corp.example.com:636' })]),
    )

    const body = bodyOf(vendorCalls(calls)[2]) as { config: Record<string, string[]> }
    assert.equal(body.config.bindCredential, undefined, 'omitting the key leaves the live secret alone')
    assert.deepEqual(body.config.connectionUrl, ['ldaps://dc2.corp.example.com:636'])
  } finally {
    restore()
  }
})

test('user-federation deploy updates the existing provider instead of creating a second one', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([liveComponent()]), noContent()])
  try {
    await deploy(deployContext([item('ldap', { ...CORP_LDAP, enabled: false })]))

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['GET ', `GET ${COMPONENTS_PATH}`, 'PUT /components/component-uuid'],
    )
    const body = bodyOf(vendor[2]) as { parentId: string; config: Record<string, string[]> }
    assert.equal(body.parentId, 'realm-uuid')
    assert.deepEqual(body.config.enabled, ['false'])
  } finally {
    restore()
  }
})

test('user-federation deploy builds a Kerberos provider without the LDAP connection fields', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([]), created(), ok([])])
  try {
    await deploy(
      deployContext([
        item('krb', {
          providerType: 'kerberos',
          name: 'corp-kerberos',
          enabled: true,
          priority: 1,
          editMode: 'READ_ONLY',
          kerberosRealm: 'CORP.EXAMPLE.COM',
          serverPrincipal: 'HTTP/keycloak.example.com@CORP.EXAMPLE.COM',
          keyTab: '/etc/krb5.keytab',
        }),
      ]),
    )

    const body = bodyOf(vendorCalls(calls)[2]) as { providerId: string; config: Record<string, string[]> }
    assert.equal(body.providerId, 'kerberos')
    assert.deepEqual(body.config.kerberosRealm, ['CORP.EXAMPLE.COM'])
    assert.equal(body.config.connectionUrl, undefined)
    assert.equal(body.config.usersDn, undefined)
  } finally {
    restore()
  }
})

test('user-federation deploy reports failure rather than throwing when Keycloak rejects the write', async () => {
  const { restore } = recordKeycloak([TOKEN, REALM, ok([]), kcError(400, 'Invalid LDAP connection URL')])
  try {
    const result = await deploy(deployContext([item('ldap', CORP_LDAP)]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /400/)
  } finally {
    restore()
  }
})

test('user-federation deploy skips an item with a blank name without writing', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([])])
  try {
    const result = await deploy(deployContext([item('blank', { ...CORP_LDAP, name: '' })]))

    assert.equal(result.success, true)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

// --- rollback -----------------------------------------------------------------

test('user-federation rollback does nothing, successfully, when there is no prior state', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(rollbackContext({ previous: [] }))

    assert.equal(result.success, true)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('user-federation rollback refuses without a credential instead of calling Keycloak', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await rollback(
      rollbackContext(
        { previous: [{ name: 'corp-ldap', id: 'component-uuid', component: liveComponent() }] },
        { credential: null },
      ),
    )

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('user-federation rollback restores the captured prior component verbatim', async () => {
  const prior = liveComponent()
  delete (prior.config as Record<string, unknown>).bindCredential
  const { calls, restore } = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'corp-ldap', id: 'component-uuid', component: prior }] }),
    )

    const vendor = vendorCalls(calls)
    assert.deepEqual(
      vendor.map((c) => `${c.method} ${adminPath(c)}`),
      ['PUT /components/component-uuid'],
    )
    const body = bodyOf(vendor[0]) as { config: Record<string, string[]> }
    assert.deepEqual(body, prior)
    assert.equal(body.config.bindCredential, undefined, 'a rollback must never write the masked placeholder back')
    assert.match(String(result.message), /1 restored/)
  } finally {
    restore()
  }
})

test('user-federation rollback deletes a provider the deploy created, tolerating a 404', async () => {
  const deleted = recordKeycloak([TOKEN, noContent()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'corp-ldap', id: 'component-uuid', component: null }] }),
    )
    assert.deepEqual(
      vendorCalls(deleted.calls).map((c) => `${c.method} ${adminPath(c)}`),
      ['DELETE /components/component-uuid'],
    )
    assert.match(String(result.message), /1 deleted/)
  } finally {
    deleted.restore()
  }

  const gone = recordKeycloak([TOKEN, notFound()])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'corp-ldap', id: 'component-uuid', component: null }] }),
    )
    assert.equal(result.success, true)
  } finally {
    gone.restore()
  }
})

test('user-federation rollback undoes the deploy in reverse order', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, noContent(), noContent()])
  try {
    await rollback(
      rollbackContext({
        previous: [
          { name: 'first', id: 'component-1', component: null },
          { name: 'second', id: 'component-2', component: null },
        ],
      }),
    )

    assert.deepEqual(
      vendorCalls(calls).map((c) => adminPath(c)),
      ['/components/component-2', '/components/component-1'],
    )
  } finally {
    restore()
  }
})

test('user-federation rollback skips an entry whose internal id was never learned', async () => {
  const { calls, restore } = recordKeycloak([TOKEN])
  try {
    const result = await rollback(rollbackContext({ previous: [{ name: 'corp-ldap', id: null, component: null }] }))

    assert.equal(result.success, true)
    assert.match(String(result.message), /1 skipped/)
    assert.equal(vendorCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('user-federation rollback reports failure rather than throwing when a restore is rejected', async () => {
  const { restore } = recordKeycloak([TOKEN, kcError(500, 'boom')])
  try {
    const result = await rollback(
      rollbackContext({ previous: [{ name: 'corp-ldap', id: 'component-uuid', component: liveComponent() }] }),
    )

    assert.equal(result.success, false)
    assert.match(String(result.message), /Rollback failed/)
  } finally {
    restore()
  }
})

// --- driftDetect --------------------------------------------------------------

test('user-federation driftDetect reports no drift and makes no calls without a credential', async () => {
  const { calls, restore } = recordKeycloak([])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)], { credential: null }))

    assert.equal(result.hasDrift, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('user-federation driftDetect reports no drift when the live provider matches', async () => {
  const { calls, restore } = recordKeycloak([TOKEN, REALM, ok([liveComponent()])])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))

    // The masked bindCredential and Keycloak's own lastSync bookkeeping must
    // not register as drift on every single scan.
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must be read-only')
  } finally {
    restore()
  }
})

test('user-federation driftDetect never puts a secret in a diff', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM,
    ok([liveComponent({ config: { connectionUrl: ['ldaps://rogue.example.com:636'] } })]),
  ])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['corp-ldap.config'],
    )
    const serialized = JSON.stringify(result)
    assert.equal(serialized.includes(BIND_PASSWORD), false, 'the declared bind password escaped into a drift diff')
    assert.equal(serialized.includes('bindCredential'), false, 'secret keys must be excluded from both sides')
  } finally {
    restore()
  }
})

test('user-federation driftDetect reports a provider disabled or re-prioritised out of band', async () => {
  const { restore } = recordKeycloak([
    TOKEN,
    REALM,
    ok([liveComponent({ config: { enabled: ['false'], priority: ['5'] } })]),
  ])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))

    assert.equal(result.hasDrift, true)
    const fields = result.diffs.map((d) => d.field)
    assert.ok(fields.includes('corp-ldap.enabled'))
    assert.ok(fields.includes('corp-ldap.priority'))
  } finally {
    restore()
  }
})

test('user-federation driftDetect skips a provider it cannot read rather than asserting false drift', async () => {
  const noRealm = recordKeycloak([TOKEN, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noRealm.restore()
  }

  const noList = recordKeycloak([TOKEN, REALM, kcError(503, 'unavailable')])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    noList.restore()
  }

  const absent = recordKeycloak([TOKEN, REALM, ok([])])
  try {
    const result = await driftDetect(driftContext([item('ldap', CORP_LDAP)]))
    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
  } finally {
    absent.restore()
  }
})

// --- healthCheck / getStatus --------------------------------------------------

describeHealthCheckContract('user-federation', healthCheck)
describeGetStatusContract('user-federation', getStatus, 'keycloak-user-federation')
