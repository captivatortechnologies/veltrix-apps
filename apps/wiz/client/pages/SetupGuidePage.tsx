import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Service accounts', 'Cloud configuration rules']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'service-account',
      label: '1. Service account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Wiz, go to <strong>Settings &gt; Service Accounts</strong> and create a{' '}
              <strong>Custom Integration (GraphQL API)</strong> service account. Grant it the API scopes
              this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Wiz shows the <strong>Client ID</strong> and <strong>Client Secret</strong> once — copy both.
              The secret is exchanged for a short-lived Bearer token via OAuth2 client credentials.
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
            <p>Store the service account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Wiz service account Client ID
              </li>
              <li>
                <strong>API token</strong> → the Wiz service account Client Secret
              </li>
            </ul>
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
              Register a <strong>wiz-tenant</strong> component whose hostname is your regional Wiz API host
              (find it in Wiz under <strong>Settings &gt; Tenant</strong>, e.g.{' '}
              <code>api.us17.app.wiz.io</code>) and attach the credential.
            </p>
            <p>
              If your tenant uses the legacy authentication backend, set the <strong>Auth Endpoint</strong>{' '}
              app setting to <code>https://auth.wiz.io/oauth/token</code> (the default is{' '}
              <code>https://auth.app.wiz.io/oauth/token</code>). The OAuth audience is derived automatically.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
