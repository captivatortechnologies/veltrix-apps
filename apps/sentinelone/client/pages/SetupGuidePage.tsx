import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Exclusions', 'Blocklist', 'Allowlist', 'STAR rules', 'Agent policy', 'Groups']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. API token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the SentinelOne console, go to <strong>Settings &gt; Users</strong> and create a{' '}
              <strong>service user</strong> (or generate an API token for a user) scoped at the level
              this app manages. The token inherits that user's role and scope:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>Copy the API token — it is sent as <code>Authorization: ApiToken …</code>.</p>
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
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the SentinelOne API token
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & scope',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>sentinelone-console</strong> component whose hostname is your
              management console URL (e.g. <code>acme.sentinelone.net</code> or{' '}
              <code>usea1-partners.sentinelone.net</code>) and attach the credential.
            </p>
            <p>
              Set the <strong>Scope</strong> app setting (<code>global</code>, <code>account</code>,{' '}
              <code>site</code> or <code>group</code>) and the <strong>Scope ID</strong> (the matching
              account/site/group id — not needed for <code>global</code>). Collections are filtered to
              this scope; the agent policy is read and written at this scope.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
