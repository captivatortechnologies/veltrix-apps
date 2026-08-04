import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMultipartBody, buildFleetUrl, buildAuthHeader } from '../fleetApi'
import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

// =============================================================================
// buildMultipartBody — the RFC 2388 encoder Scripts (and any future
// multipart-only Fleet endpoint) relies on. Pure and network-free.
// =============================================================================

test('buildMultipartBody encodes fields and a file part with a random boundary', () => {
  const { body, contentType } = buildMultipartBody(
    [{ name: 'fleet_id', value: '3' }],
    [{ name: 'script', filename: 'check.sh', content: "echo 'hi'\n", contentType: 'text/plain' }],
  )

  const boundaryMatch = contentType.match(/^multipart\/form-data; boundary=(.+)$/)
  assert.ok(boundaryMatch, 'contentType must declare a boundary')
  const boundary = boundaryMatch![1]

  const text = body.toString('utf8')
  assert.ok(text.includes(`--${boundary}`))
  assert.ok(text.includes('Content-Disposition: form-data; name="fleet_id"'))
  assert.ok(text.includes('\r\n\r\n3\r\n'))
  assert.ok(text.includes('Content-Disposition: form-data; name="script"; filename="check.sh"'))
  assert.ok(text.includes('Content-Type: text/plain'))
  assert.ok(text.includes("echo 'hi'"))
  assert.ok(text.trim().endsWith(`--${boundary}--`))
})

test('buildMultipartBody preserves binary Buffer file content byte-for-byte', () => {
  const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x10])
  const { body } = buildMultipartBody([], [{ name: 'profile', filename: 'p.mobileconfig', content: binary }])
  assert.ok(body.includes(binary))
})

test('buildMultipartBody uses a fresh boundary each call (no collision)', () => {
  const a = buildMultipartBody([{ name: 'x', value: '1' }], [])
  const b = buildMultipartBody([{ name: 'x', value: '1' }], [])
  assert.notEqual(a.contentType, b.contentType)
})

// =============================================================================
// buildFleetUrl / buildAuthHeader — already covered indirectly by other config
// types' tests, but the multipart-heavy types below rely on the same seam, so
// a couple of direct checks live here for quick regression signal.
// =============================================================================

test('buildFleetUrl prefers an explicit connectivity URL over the component port', () => {
  const component = { id: 'c1', hostname: 'fleet.internal', port: '8080', type: ['fleet-server'], toolId: 'fleet' } as ComponentRef
  const url = buildFleetUrl(component, { id: 'conn1', status: 'active', sshCommand: null, httpsUrl: 'https://fleet.example.com/', tailscaleDeviceIP: null }, null)
  assert.equal(url, 'https://fleet.example.com')
})

test('buildAuthHeader falls back to credential.password when apiToken is absent', () => {
  const headers = buildAuthHeader({ id: 'cred1', name: 'default', username: '', password: 'tok123', apiToken: null, certificate: null } as CredentialRef)
  assert.deepEqual(headers, { Authorization: 'Bearer tok123' })
})
