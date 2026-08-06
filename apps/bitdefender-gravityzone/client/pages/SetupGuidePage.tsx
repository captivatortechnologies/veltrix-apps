import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const ACTION_CATEGORIES = ['General', 'Network', 'Policy', 'Packages', 'Companies', 'Accounts', 'Push notifications', 'Integrations']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-key',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Sign in to the <strong>GravityZone Control Center</strong>, open the user menu, go to{' '}
              <strong>My Account &gt; API keys</strong>, and add a new key. Grant it every action category
              this app calls:
            </p>
            <div>
              {ACTION_CATEGORIES.map((c) => (
                <Badge key={c} variant="primary" size="sm">
                  {c}
                </Badge>
              ))}
            </div>
            <p>
              GravityZone shows the key's value only once — copy it immediately. See Bitdefender's own{' '}
              <a href="https://www.bitdefender.com/business/support/en/77212-125277-public-api.html" target="_blank" rel="noreferrer">
                Public API
              </a>{' '}
              documentation for the exact steps.
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
            <p>Store the API key as a Veltrix credential's "API token" field — there is no separate username.</p>
            <p>
              Every request authenticates with{' '}
              <code>Authorization: Basic base64(&quot;&lt;apiKey&gt;:&quot;)</code> — the key as the HTTP
              Basic username, with an empty password. There is no session or token exchange.
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
              Register a <strong>gravityzone-tenant</strong> component whose hostname is your Control Center
              API host — <code>cloud.gravityzone.bitdefender.com</code> for the default Cloud console, or your
              on-premises/regional Control Center's hostname — and attach the credential. The app calls{' '}
              <code>https://&lt;host&gt;/api/v1.0/jsonrpc/&lt;service&gt;</code> (JSON-RPC 2.0, one endpoint
              per service).
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
              <strong>Policy Module States</strong> only enables/disables an EXISTING policy's protection
              modules — GravityZone's Policies service has no create/update for a policy's full definition.
              Author the policy itself in the Control Center console first, then reference its Policy ID here.
            </p>
            <p>
              <strong>Network Groups</strong> reconcile by (groupName, parentId) — GravityZone has no rename
              API, so changing a group's name creates a new group rather than renaming the old one.
            </p>
            <p>
              <strong>Policy Assignments</strong> target endpoint ids you already know (from the GravityZone
              console or Network Inventory) — this app does not browse or discover endpoints itself.
            </p>
            <p>
              <strong>Push Event Settings</strong> is a singleton — declare it at most once per canvas.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
