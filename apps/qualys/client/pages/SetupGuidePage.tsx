import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Asset groups', 'Static search lists', 'Scan schedules']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'account',
      label: '1. API account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Qualys, create a dedicated <strong>service account</strong> (Users) with{' '}
              <strong>API access</strong> enabled and a role scoped to what this app manages. Qualys
              authenticates with HTTP Basic (username + password):
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
            <p>Store the Qualys account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Qualys account username
              </li>
              <li>
                <strong>Password</strong> → the account password
              </li>
            </ul>
            <p>
              The app sends these as <code>Authorization: Basic …</code> with the required{' '}
              <code>X-Requested-With</code> header to your platform's{' '}
              <code>/api/2.0/fo/</code> endpoints.
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
              Register a <strong>qualys-platform</strong> component whose hostname is your Qualys API
              server. Find it under <strong>Help &gt; About</strong> in the Qualys UI — e.g.{' '}
              <code>qualysapi.qualys.com</code> (US1), <code>qualysapi.qg2.apps.qualys.com</code> (US2)
              or <code>qualysapi.qg1.apps.qualys.eu</code> (EU1) — and attach the credential.
            </p>
            <p>
              Each subscription lives on exactly one platform; using the wrong platform URL returns an
              authentication error even with valid credentials.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
