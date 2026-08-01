import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Watch Lists']

/**
 * Step-by-step connection guide for Recorded Future, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API Token',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Request a Recorded Future <strong>API token</strong> from the support portal
              (<strong>support.recordedfuture.com → Requesting API Tokens</strong>), scoped to the
              <strong> List API</strong> so it can create and manage Watch Lists:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the token as a Veltrix credential on the <strong>Connections</strong> page — paste it in
              the <strong>API token</strong> field. Recorded Future sends the token verbatim in the{' '}
              <code>X-RFToken</code> request header (no username needed).
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
              On <strong>Connections</strong>, add a connection whose endpoint is the Recorded Future API host —
              the default is <code>api.recordedfuture.com</code> (override only for a regional / dedicated
              cloud) — and attach the API token. Use <strong>Test</strong> to verify the token authenticates
              against the List API (POST <code>/list/search</code>). Saving the connection also registers the
              Recorded Future cloud as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Recorded Future{' '}
              <strong>Watch Lists</strong> configuration type, author your lists (name, type and member
              entities), and deploy through the pipeline. Deploy creates the list if needed and adds its
              entities; drift detection and rollback are handled per list.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
