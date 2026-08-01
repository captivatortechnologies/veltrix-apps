import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'trend-micro-vision-one',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/trend-micro-vision-one/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/trend-micro-vision-one/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/trend-micro-vision-one/connections', label: 'Connections', icon: 'link' },
  ],
}
