// Health for the pipeline-rules config = Graylog answers on its REST API
// (GET /api/system). Shared across every Graylog config type.
export { graylogSystemHealthCheck as default } from '../../lib/handlerHelpers'
