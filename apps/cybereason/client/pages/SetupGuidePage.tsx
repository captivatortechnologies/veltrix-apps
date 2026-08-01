import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Custom reputations (allowlist / blocklist)']

/**
 * Step-by-step connection guide for Cybereason, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Cybereason, use (or create) a platform account with API access and permission to manage
              reputations. This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store that account's <strong>username and password</strong> as a Veltrix credential on the{' '}
              <strong>Connections</strong> page. Cybereason authenticates with a session-cookie login (the app
              posts the credentials to <code>/login.html</code> and reuses the returned <code>JSESSIONID</code>).
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
              On <strong>Connections</strong>, add a connection pointing at your tenant URL
              (<code>https://&lt;tenant&gt;.cybereason.net</code>) and attach the username / password credential.
              Use <strong>Test</strong> to verify Cybereason is reachable and the account authenticates (login →
              GET <code>/rest/classification/download</code>). Saving the connection also registers the
              Cybereason tenant as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Cybereason{' '}
              <strong>Custom Reputations</strong> configuration type, author your entries (key type, key,
              reputation, prevent execution, comment), and deploy through the pipeline. Drift detection and
              rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
