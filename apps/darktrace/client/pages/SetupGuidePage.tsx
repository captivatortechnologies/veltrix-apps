import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Intel-feed watched domains']

/**
 * Step-by-step connection guide for Darktrace, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. DSA token pair',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Darktrace, go to <strong>Admin → System Config → API Tokens</strong> and generate a token
              pair. Darktrace's DSA auth uses <strong>two</strong> tokens: a <strong>public token</strong>{' '}
              (sent in the clear) and a <strong>private token</strong> (the HMAC secret — shown once, at
              creation). This app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Store the pair as a Veltrix credential on the <strong>Connections</strong> page: the{' '}
              <strong>public token</strong> as the username and the <strong>private token</strong> as the
              secret. Every request is signed <code>HMAC-SHA1</code> over the request path — no token is ever
              sent unsigned.
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
              On <strong>Connections</strong>, add a connection pointing at your Darktrace master (its HTTPS
              address on 443) and attach the token pair. Use <strong>Test</strong> to verify Darktrace is
              reachable and the pair signs correctly (GET <code>/intelfeed?sources=true</code>). Saving the
              connection also registers the Darktrace instance as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Darktrace{' '}
              <strong>Watched Domains</strong> configuration type, author your entries (domain / IP /
              hostname, source list, description, expiry, hostname &amp; Antigena flags), and deploy through
              the pipeline. Deploy adds new entries idempotently; rollback removes exactly what it added;
              drift detection flags entries removed out-of-band.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
