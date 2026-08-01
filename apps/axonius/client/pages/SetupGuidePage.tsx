import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Saved queries']

/**
 * Step-by-step connection guide for Axonius, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API key & secret',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Axonius, open your <strong>account page</strong> (gear icon → My Account, or{' '}
              <code>https://&lt;tenant&gt;/account</code>) and copy the <strong>API Key</strong> and{' '}
              <strong>API Secret</strong>. On Axonius 6.1.74 and later the REST API is only accessible via a{' '}
              <strong>service account</strong>, so create one and use its key/secret. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the API key as the credential <strong>username</strong> and the API secret as the{' '}
              <strong>token</strong> on the <strong>Connections</strong> page.
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
              On <strong>Connections</strong>, add a connection pointing at your Axonius tenant (its HTTPS
              address on 443) and attach the API key + secret. Use <strong>Test</strong> to verify Axonius is
              reachable and the credentials authenticate (GET <code>api/settings/meta/about</code>). Saving the
              connection also registers the Axonius tenant as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Axonius <strong>Saved Queries</strong>
              configuration type, author your queries (name, asset module, AQL filter, columns), and deploy
              through the pipeline. Drift detection and rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
