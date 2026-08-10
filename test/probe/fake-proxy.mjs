// Stands in for the LiteLLM proxy so the probe exercises the catalog path
// under real opencode startup conditions without touching a remote host.
import { createServer } from 'node:http'

const MODELS = [
  { id: 'ai-gateway-gpt-5.4', object: 'model', created: 1677610602, owned_by: 'openai' },
  { id: 'ai-gateway-gpt-5.4-mini', object: 'model' },
  { id: 'ai-gateway-text-embedding-3-small', object: 'model' },
]

createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url?.startsWith('/v1/models')) {
    res.end(JSON.stringify({ data: MODELS }))
    return
  }
  res.statusCode = 404
  res.end('{}')
}).listen(7801, '127.0.0.1')
