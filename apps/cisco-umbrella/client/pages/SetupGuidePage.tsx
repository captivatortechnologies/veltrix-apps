import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// API key scope this app needs, granted on the Umbrella API key.
const SCOPES = ['Destination Lists (read/write)']

/**
 * Step-by-step connection guide for the Cisco Umbrella app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui. Umbrella
 * authenticates with an OAuth2 API key + secret (client-credentials).
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
              In the Umbrella dashboard, go to <strong>Admin &gt; API Keys</strong> and create a new
              API key. Give it the <strong>Destination Lists</strong> scope with read/write access.
              Copy the <strong>API Key</strong> and <strong>API Secret</strong> — the secret is shown
              only once.
            </p>
            <p>Grant the key these scopes:</p>
            <div>
              {SCOPES.map((s) => (
                <Badge key={s} variant="primary" size="sm">
                  {s}
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
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the API Key
              </li>
              <li>
                <strong>API token</strong> → the API Secret
              </li>
            </ul>
            <p>
              The app exchanges the key + secret for a short-lived bearer token via the Umbrella
              OAuth2 client-credentials flow (<code>POST /auth/v2/token</code>) on every run — the
              secret is never sent to any endpoint other than the token endpoint.
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
            <p>
              On the <strong>Connections</strong> page create a <strong>cisco-umbrella</strong>{' '}
              connection and attach the credential. The base URL is fixed to{' '}
              <code>https://api.umbrella.com</code>. Use <strong>Test</strong> to verify the key/secret
              against the destination lists endpoint.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Destination lists are matched by name and the Umbrella list id is stored after
              deploy so a rename updates the same list; a list's destinations are synced to exactly
              what you declare.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
