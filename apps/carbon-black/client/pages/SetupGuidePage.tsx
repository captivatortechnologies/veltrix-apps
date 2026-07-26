import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// The API-key permission this app needs (Custom access level).
const PERMISSIONS = ['org.reputations: CREATE', 'org.reputations: READ', 'org.reputations: DELETE']

/**
 * Step-by-step connection guide for the Carbon Black Cloud app, rendered with
 * the platform design-system components from @veltrixsecops/app-sdk/ui — the
 * same Tabs / Card / Badge the built-in platform screens use, themed to the
 * app's brand color. Carbon Black authenticates with an API key.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'apikey',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Carbon Black Cloud console, go to <strong>Settings &gt; API Access</strong>.
              Create a <strong>Custom</strong> access level granting the reputation permission:
            </p>
            <div>
              {PERMISSIONS.map((p) => (
                <Badge key={p} variant="primary" size="sm">
                  {p}
                </Badge>
              ))}
            </div>
            <p>
              Then create an API key with that access level. Copy the <strong>API ID</strong> and{' '}
              <strong>API Secret Key</strong>, and note your <strong>Org Key</strong> (Settings &gt;
              General).
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
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the API ID
              </li>
              <li>
                <strong>Password</strong> → the API Secret Key
              </li>
            </ul>
            <p>
              The app sends these as <code>X-Auth-Token: &lt;secret&gt;/&lt;id&gt;</code> (secret
              first) on every request.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '3. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Set the app's settings:</p>
            <ul>
              <li>
                <strong>Base URL</strong> → your region host (e.g.{' '}
                <code>https://defense.conferdeploy.net</code>; EU/APAC orgs differ).
              </li>
              <li>
                <strong>Org Key</strong> → your organization key.
              </li>
            </ul>
            <p>
              Then on the <strong>Connections</strong> page create a <strong>carbon-black</strong>{' '}
              connection, attach the credential, and <strong>Test</strong> it. Author a configuration
              in the Configuration Canvas and deploy it — reputation overrides are matched by their
              natural key (hash / certificate / path) and applied as delete + recreate, since Carbon
              Black has no update API.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
