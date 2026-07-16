import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Snyk Code (SAST)', 'Notifications', 'Integration settings', 'Service accounts', 'Webhooks']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. Service-account token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Snyk, create a <strong>service account</strong> (Settings &gt; Service accounts) with a
              role scoped to what this app manages, and copy its API token. A service-account token is
              preferred over a personal token for automation:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
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
                <strong>API token</strong> → the Snyk service-account token
              </li>
            </ul>
            <p>
              The app sends it as <code>Authorization: token &lt;token&gt;</code>. Snyk tokens are
              region-scoped — use the region host that matches the account.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & org',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>snyk-org</strong> component whose hostname is your Snyk region API host
              — <code>api.snyk.io</code> (US), <code>api.eu.snyk.io</code> (EU) or{' '}
              <code>api.au.snyk.io</code> (AU) — and attach the credential.
            </p>
            <p>
              Then set the <strong>Organization ID</strong> app setting (Snyk: Settings &gt; General &gt;
              Organization ID). Most Snyk configuration is org-scoped, so it is required for deployments.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
