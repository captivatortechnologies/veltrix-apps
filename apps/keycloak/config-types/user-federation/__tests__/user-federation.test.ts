import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildComponentRep,
  findComponentByName,
  fromComponentConfig,
  joinUserObjectClasses,
  nonSecretConfig,
  projectFromFields,
  projectFromLive,
  splitUserObjectClasses,
  stripSecretsFromComponent,
  toComponentConfig,
  USER_STORAGE_PROVIDER_TYPE,
  type KeycloakComponentRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const goodLdap = {
  providerType: 'ldap',
  name: 'corp-ldap',
  enabled: true,
  priority: 0,
  editMode: 'READ_ONLY',
  importEnabled: true,
  syncRegistrations: false,
  vendor: 'ad',
  usernameLdapAttribute: 'sAMAccountName',
  rdnLdapAttribute: 'cn',
  uuidLdapAttribute: 'objectGUID',
  userObjectClasses: ['person', 'organizationalPerson', 'user'],
  connectionUrl: 'ldap://ad.example.com:389',
  usersDn: 'ou=Users,dc=example,dc=com',
  authType: 'simple',
  bindDn: 'cn=admin,dc=example,dc=com',
  bindCredential: 's3cr3t',
  searchScope: '2',
  pagination: true,
  startTls: false,
  connectionPooling: false,
  batchSizeForSync: 1000,
  validatePasswordPolicy: false,
  trustEmail: false,
  usePasswordModifyExtendedOp: false,
  allowKerberosAuthentication: false,
}

const goodKerberos = {
  providerType: 'kerberos',
  name: 'corp-kerberos',
  enabled: true,
  priority: 0,
  editMode: 'READ_ONLY',
  kerberosRealm: 'EXAMPLE.COM',
  serverPrincipal: 'HTTP/host.example.com@EXAMPLE.COM',
  keyTab: '/etc/krb5.keytab',
  useKerberosForPasswordAuthentication: false,
  debug: false,
}

// --- validate ----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name with whitespace', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, name: 'corp ldap' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([goodLdap, { ...goodLdap, connectionUrl: 'ldap://other:389' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good LDAP provider', async () => {
  const res = await validate(ctxOf([goodLdap]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a good standalone Kerberos provider', async () => {
  const res = await validate(ctxOf([goodKerberos]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate requires LDAP-only fields when providerType is ldap', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, connectionUrl: '', usersDn: '', usernameLdapAttribute: '', rdnLdapAttribute: '', uuidLdapAttribute: '', userObjectClasses: [] }]))
  assert.equal(res.valid, false)
  const codes = res.errors.map((e) => e.code)
  assert.ok(codes.includes('EMPTY_CONNECTION_URL'))
  assert.ok(codes.includes('EMPTY_USERS_DN'))
  assert.ok(codes.includes('EMPTY_USERNAME_ATTRIBUTE'))
  assert.ok(codes.includes('EMPTY_RDN_ATTRIBUTE'))
  assert.ok(codes.includes('EMPTY_UUID_ATTRIBUTE'))
  assert.ok(codes.includes('EMPTY_USER_OBJECT_CLASSES'))
})

test('validate requires Kerberos fields when providerType is kerberos', async () => {
  const res = await validate(ctxOf([{ ...goodKerberos, kerberosRealm: '', serverPrincipal: '', keyTab: '' }]))
  assert.equal(res.valid, false)
  const codes = res.errors.map((e) => e.code)
  assert.ok(codes.includes('EMPTY_KERBEROS_REALM'))
  assert.ok(codes.includes('EMPTY_SERVER_PRINCIPAL'))
  assert.ok(codes.includes('EMPTY_KEY_TAB'))
})

test('validate requires Kerberos fields on an LDAP item that opts into Kerberos auth', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, allowKerberosAuthentication: true }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_KERBEROS_REALM'))
})

test('validate does not require Kerberos fields on a plain LDAP item', async () => {
  const res = await validate(ctxOf([goodLdap]))
  assert.ok(!res.errors.some((e) => e.code === 'EMPTY_KERBEROS_REALM'))
})

test('validate rejects a bindDn set without a bindCredential', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, bindCredential: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INCOMPLETE_BIND_CREDENTIALS'))
})

test('validate rejects a bindCredential set without a bindDn', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, bindDn: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INCOMPLETE_BIND_CREDENTIALS'))
})

test('validate accepts an anonymous bind (both bindDn and bindCredential blank)', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, bindDn: '', bindCredential: '' }]))
  assert.ok(!res.errors.some((e) => e.code === 'INCOMPLETE_BIND_CREDENTIALS'))
})

test('validate rejects a custom user search filter without parentheses', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, customUserSearchFilter: 'memberOf=cn=x' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEARCH_FILTER'))
})

test('validate accepts a well-formed custom user search filter', async () => {
  const res = await validate(ctxOf([{ ...goodLdap, customUserSearchFilter: '(memberOf=cn=keycloak-users,ou=Groups,dc=example,dc=com)' }]))
  assert.ok(!res.errors.some((e) => e.code === 'INVALID_SEARCH_FILTER'))
})

test('validate rejects an unknown editMode/vendor/authType/searchScope', async () => {
  const res = await validate(
    ctxOf([{ ...goodLdap, editMode: 'BOGUS', vendor: 'BOGUS', authType: 'BOGUS', searchScope: 'BOGUS' }]),
  )
  assert.equal(res.valid, false)
  const codes = res.errors.map((e) => e.code)
  assert.ok(codes.includes('INVALID_EDIT_MODE'))
  assert.ok(codes.includes('INVALID_VENDOR'))
  assert.ok(codes.includes('INVALID_AUTH_TYPE'))
  assert.ok(codes.includes('INVALID_SEARCH_SCOPE'))
})

// --- _shared: config wrap/unwrap ----------------------------------------------

test('toComponentConfig wraps a flat map into single-element arrays', () => {
  assert.deepEqual(toComponentConfig({ enabled: 'true', priority: '0' }), { enabled: ['true'], priority: ['0'] })
})

test('fromComponentConfig flattens to the first value per key', () => {
  assert.deepEqual(fromComponentConfig({ enabled: ['true'], vendor: ['AD', 'ignored'] }), { enabled: 'true', vendor: 'AD' })
  assert.deepEqual(fromComponentConfig(undefined), {})
})

test('userObjectClasses joins to a single comma-and-space-joined string and splits back', () => {
  const classes = ['inetOrgPerson', 'organizationalPerson']
  const joined = joinUserObjectClasses(classes)
  assert.equal(joined, 'inetOrgPerson, organizationalPerson')
  assert.deepEqual(splitUserObjectClasses(joined), classes)
})

test('splitUserObjectClasses tolerates uneven spacing and blanks', () => {
  assert.deepEqual(splitUserObjectClasses('inetOrgPerson,  organizationalPerson ,'), ['inetOrgPerson', 'organizationalPerson'])
  assert.deepEqual(splitUserObjectClasses(undefined), [])
})

// --- _shared: secret handling --------------------------------------------------

test('nonSecretConfig drops bindCredential and keyTab from a flat map', () => {
  assert.deepEqual(
    nonSecretConfig({ connectionUrl: 'ldap://x', bindCredential: 'shh', keyTab: '/etc/krb5.keytab', usersDn: 'ou=Users' }),
    { connectionUrl: 'ldap://x', usersDn: 'ou=Users' },
  )
})

test('stripSecretsFromComponent drops secret keys from the raw multi-valued config but preserves everything else', () => {
  const component: KeycloakComponentRep = {
    id: 'uuid-1',
    name: 'corp-ldap',
    providerId: 'ldap',
    config: { connectionUrl: ['ldap://x'], bindCredential: ['**********'], lastSync: ['1700000000'] },
  }
  const stripped = stripSecretsFromComponent(component)
  assert.equal(stripped.id, 'uuid-1')
  assert.deepEqual(stripped.config, { connectionUrl: ['ldap://x'], lastSync: ['1700000000'] })
  assert.ok(!('bindCredential' in (stripped.config ?? {})))
})

test('stripSecretsFromComponent tolerates a component with no config', () => {
  const stripped = stripSecretsFromComponent({ id: 'uuid-1', name: 'x' })
  assert.equal(stripped.id, 'uuid-1')
})

// --- _shared: buildComponentRep -------------------------------------------------

test('buildComponentRep builds a full LDAP ComponentRepresentation', () => {
  const rep = buildComponentRep(goodLdap)
  assert.equal(rep.name, 'corp-ldap')
  assert.equal(rep.providerId, 'ldap')
  assert.equal(rep.providerType, USER_STORAGE_PROVIDER_TYPE)
  assert.deepEqual(rep.config?.enabled, ['true'])
  assert.deepEqual(rep.config?.userObjectClasses, ['person, organizationalPerson, user'])
  assert.deepEqual(rep.config?.bindCredential, ['s3cr3t'])
  // Wire key is the all-caps-LDAP form (verified against Keycloak's
  // LDAPConstants source) — NOT this app's own camelCase field-key spelling.
  assert.deepEqual(rep.config?.usernameLDAPAttribute, ['sAMAccountName'])
  assert.equal(rep.config?.usernameLdapAttribute, undefined)
})

test('buildComponentRep builds a minimal Kerberos ComponentRepresentation with no LDAP connection fields', () => {
  const rep = buildComponentRep(goodKerberos)
  assert.equal(rep.providerId, 'kerberos')
  assert.deepEqual(rep.config?.kerberosRealm, ['EXAMPLE.COM'])
  assert.deepEqual(rep.config?.keyTab, ['/etc/krb5.keytab'])
  assert.equal(rep.config?.connectionUrl, undefined)
  assert.equal(rep.config?.usersDn, undefined)
  assert.equal(rep.config?.vendor, undefined)
})

test('buildComponentRep omits bindCredential/keyTab from config when left blank (write-only)', () => {
  const rep = buildComponentRep({ ...goodLdap, bindDn: '', bindCredential: '' })
  assert.equal(rep.config?.bindCredential, undefined)
})

test('buildComponentRep on update never lets a masked prior secret survive into the merged config', () => {
  const existing: KeycloakComponentRep = {
    id: 'uuid-1',
    name: 'corp-ldap',
    providerId: 'ldap',
    parentId: 'realm-internal-id',
    config: {
      connectionUrl: ['ldap://old:389'],
      bindCredential: ['**********'], // masked — never the real value
      lastSync: ['1700000000'], // an unmanaged, Keycloak-owned extra
    },
  }
  const rep = buildComponentRep({ ...goodLdap, bindDn: '', bindCredential: '' }, existing)
  assert.equal(rep.id, 'uuid-1')
  // Unmanaged live keys survive an update.
  assert.deepEqual(rep.config?.lastSync, ['1700000000'])
  // The freshly authored connectionUrl wins over the prior value.
  assert.deepEqual(rep.config?.connectionUrl, ['ldap://ad.example.com:389'])
  // Left blank this deploy AND stripped from the prior body — never the masked placeholder.
  assert.equal(rep.config?.bindCredential, undefined)
})

test('buildComponentRep lets a newly declared secret rotate the value on update', () => {
  const existing: KeycloakComponentRep = {
    id: 'uuid-1',
    name: 'corp-ldap',
    providerId: 'ldap',
    config: { bindCredential: ['**********'] },
  }
  const rep = buildComponentRep(goodLdap, existing)
  assert.deepEqual(rep.config?.bindCredential, ['s3cr3t'])
})

// --- _shared: projection / drift ------------------------------------------------

test('findComponentByName matches by exact name', () => {
  const components: KeycloakComponentRep[] = [{ id: '1', name: 'a' }, { id: '2', name: 'corp-ldap' }]
  assert.equal(findComponentByName(components, 'corp-ldap')?.id, '2')
  assert.equal(findComponentByName(components, 'missing'), null)
})

test('projectFromFields excludes secrets from config', () => {
  const projected = projectFromFields(goodLdap)
  assert.equal(projected.config.bindCredential, undefined)
  assert.equal(projected.providerId, 'ldap')
  assert.equal(projected.enabled, true)
  assert.equal(projected.priority, 0)
})

test('projectFromLive agrees with projectFromFields for an unchanged LDAP component (secret masked live)', () => {
  const expected = projectFromFields(goodLdap)
  const live: KeycloakComponentRep = {
    id: 'uuid-1',
    name: 'corp-ldap',
    providerId: 'ldap',
    config: buildComponentRep(goodLdap).config,
  }
  // Simulate what a live GET actually returns: the secret masked, plus an
  // unmanaged Keycloak-only extra that drift must not flag.
  live.config = { ...live.config, bindCredential: ['**********'], lastSync: ['1700000000'] }
  assert.deepEqual(projectFromLive(live), expected)
})

test('projectFromLive excludes unmanaged Keycloak-internal config keys from the comparison', () => {
  const live: KeycloakComponentRep = {
    providerId: 'ldap',
    config: { ...buildComponentRep(goodLdap).config, cachePolicy: ['DEFAULT'], lastSync: ['1700000000'] },
  }
  const projected = projectFromLive(live)
  assert.equal(projected.config.cachePolicy, undefined)
  assert.equal(projected.config.lastSync, undefined)
})

test('projectFromLive for a Kerberos component reads providerId/enabled/priority correctly', () => {
  const live: KeycloakComponentRep = {
    providerId: 'kerberos',
    config: buildComponentRep(goodKerberos).config,
  }
  const projected = projectFromLive(live)
  assert.equal(projected.providerId, 'kerberos')
  assert.equal(projected.enabled, true)
  assert.equal(projected.priority, 0)
  assert.deepEqual(projected.config.kerberosRealm, 'EXAMPLE.COM')
})
