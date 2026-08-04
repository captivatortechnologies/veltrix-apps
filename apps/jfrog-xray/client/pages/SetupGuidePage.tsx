import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Security policies',
  'License policies',
  'Operational risk policies',
  'Curation policies',
  'Watches',
  'Ignore rules',
  'Custom issues',
  'Webhooks',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'access-token',
      label: '1. Access token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the JFrog Platform, go to <strong>Administration &gt; User Management &gt; Access
              Tokens</strong> and generate a token scoped to a user or group that has been granted the
              Xray <strong>Manage Policies</strong>, <strong>Read Policies</strong> and{' '}
              <strong>Manage Watches</strong> permissions (the last one also covers ignore rules and
              custom issues) plus <strong>Manage Xray Metadata</strong> for custom issues specifically.
              Copy the token — JFrog shows it once.
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              The legacy API Key (<code>X-JFrog-Art-Api</code>) reached End of Life at the end of
              2024 and cannot be used — this app authenticates with an Access Token only.
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
            <p>Store the Access Token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Access token</strong> → the JFrog Platform Access Token
              </li>
            </ul>
            <p>No username is required — a JFrog Access Token is self-contained.</p>
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
              Register a <strong>jfrog-xray-instance</strong> component whose hostname is your JFrog
              Platform base URL — the same host you use for Artifactory and Xray (e.g.{' '}
              <code>mycompany.jfrog.io</code>, or your self-hosted front door) — and attach the
              credential. Requests go to <code>https://&lt;host&gt;/xray/api/…</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
