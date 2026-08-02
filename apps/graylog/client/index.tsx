import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'graylog',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/graylog/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/graylog/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/graylog/connections', label: 'Connections', icon: 'link' },
  ],
}
