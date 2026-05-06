# Centramind HTTP Gateway

HTTP gateway for Centramind MCP tools. Exposes every registered tool as a REST endpoint.

## URL pattern

```
POST /v1/<domain>.<tool>
```

Examples:
- `POST /v1/projects.list`
- `POST /v1/infra.get`
- `POST /v1/projects.update_status`

## Authentication

```
Authorization: Bearer <api_key>
```

API keys are stored in the `API_KEYS` KV namespace. Each key resolves to an AuthContext containing `tenant_id`, `user_id`, `role`, and `scopes`.

Optional header: `X-Tenant-Slug` (must match the key's tenant).

## Request body

```json
{ "args": { "slug": "lamarnie" } }
```

Or pass args directly at top level:

```json
{ "slug": "lamarnie" }
```

## Response shape

Success:
```json
{
  "result": { ... },
  "ctx": { "tenant_id": "eternium", "role": "owner" }
}
```

Error:
```json
{
  "error": "Description of what went wrong",
  "code": "error_code"
}
```

## Rate limit

60 requests per minute per API key (sliding window, KV-backed).

## Audit log

Every tool call (success or failure) is logged to `fleet_events` with `event_type = 'mcp_tool_call'`.

## Files

- `gateway.js` - Main request handler
- `registry.js` - Tool name to service function + zod schema mapping
- `auth.js` - API key resolution to AuthContext
- `audit.js` - fleet_events audit logging
- `rate-limit.js` - KV-backed sliding window rate limiter
