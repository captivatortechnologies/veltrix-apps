import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Functional accounts']

/**
 * Step-by-step connection guide for BeyondTrust Password Safe, rendered with the
 * platform design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API key & run-as user',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In BeyondInsight, go to <strong>Configuration → General → API Registrations</strong> and create
              (or reuse) an API registration. Copy its <strong>API key</strong>, and note a BeyondInsight
              user with API access to run the calls as (the <strong>run-as user</strong>). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API key and run-as user as a Veltrix credential on the <strong>Connections</strong>
              page. Password Safe authenticates the API key with the header{' '}
              <code>PS-Auth key=&lt;api-key&gt;; runas=&lt;user&gt;;</code> at{' '}
              <code>POST /Auth/SignAppIn</code>. If the registration requires a user password, add it to the
              credential as well.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection pointing at your BeyondInsight host (its HTTPS
              address on 443 — the app appends <code>/BeyondTrust/api/public/v3</code>) and attach the API key
              + run-as user. Use <strong>Test</strong> to verify Password Safe is reachable and the credential
              authenticates (<code>POST /Auth/SignAppIn</code>). Saving the connection also registers the
              Password Safe host as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the BeyondTrust{' '}
              <strong>Functional Accounts</strong> configuration type, author your accounts (platform ID,
              account name, domain, display name, elevation), and deploy through the pipeline. Deploy creates
              any account that is missing; drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
