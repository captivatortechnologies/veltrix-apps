import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Endpoint policies',
  'Endpoint groups',
  'Scanning exclusions',
  'Allowed / blocked items',
  'Web Control local sites',
  'Exploit Mitigation exclusions',
  'Custom roles',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'service-principal',
      label: '1. Service principal',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Sign in to <strong>Sophos Central Admin</strong> as a Super Admin, go to{' '}
              <strong>Global Settings &gt; API Credentials</strong>, and add a new set of credentials. This is a
              TENANT-level service principal — it authenticates against your own tenant only, not a partner or
              organization (Enterprise) account. It should be able to manage:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              See Sophos's own{' '}
              <a href="https://developer.sophos.com/getting-started-tenant" target="_blank" rel="noreferrer">
                Getting Started as a Tenant
              </a>{' '}
              guide for the exact steps.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the service principal as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Client ID</strong> → the credential's "username" field
              </li>
              <li>
                <strong>Client Secret</strong> → the credential's "API token" field
              </li>
            </ul>
            <p>
              The app exchanges these for a bearer token via{' '}
              <code>POST https://id.sophos.com/api/v2/oauth2/token</code> (OAuth2 client-credentials grant), then
              calls <code>GET https://api.central.sophos.com/whoami/v1</code> to discover your tenant id and its
              data-region API host. Every subsequent request carries{' '}
              <code>Authorization: Bearer &lt;token&gt;</code> and <code>X-Tenant-ID: &lt;tenant-id&gt;</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>sophos-tenant</strong> component and attach the credential. There is no per-tenant
              API host to configure — the app discovers your tenant's data-region host automatically on every
              connection, so the component's hostname is only a human label (e.g. your tenant's name).
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'per-type-notes',
      label: '4. Per-type notes',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              <strong>Endpoint Policies</strong> reconcile by (name, type) — <code>type</code> is immutable after
              creation. The policy's <code>appliesTo</code> and <code>settings</code> are authored as JSON, since
              Sophos documents their shape as "keys have specific names documented here" rather than a fixed schema.
            </p>
            <p>
              <strong>Endpoint Groups</strong> use a static endpoint-id list — Sophos has no dynamic/query-based
              group membership. Find endpoint UUIDs via the Sophos Central console or{' '}
              <code>GET /endpoint/v1/endpoints</code>.
            </p>
            <p>
              <strong>Blocked Items</strong> have no update API — a changed item is deleted and recreated.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
