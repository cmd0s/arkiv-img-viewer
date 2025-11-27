# ARKIV SDK Complete Guide

A comprehensive guide for using the ARKIV Web3 database with JavaScript/TypeScript SDK. This guide includes practical patterns and lessons learned from production usage.

## What is ARKIV?

ARKIV is a decentralized blockchain database where each entry (entity) has:
- **Unique key** - Ethereum address format (0x...)
- **Payload** - Binary data (JSON, images, files)
- **Attributes** - Key-value pairs for filtering and indexing
- **Owner** - Wallet address that created the entity
- **Expiration** - Optional TTL for automatic deletion

## Quick Start

### Installation

```bash
npm install @arkiv-network/sdk
```

### Package.json Setup

```json
{
  "type": "module",
  "engines": {
    "node": ">=22.10.0"
  }
}
```

### Basic Reading Example

```typescript
import { createPublicClient, http } from "@arkiv-network/sdk"
import { mendoza } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"

const publicClient = createPublicClient({
  chain: mendoza,
  transport: http(),
})

// Get single entity by key
const entity = await publicClient.getEntity("0x1234...")
console.log(entity.payload) // Binary data
console.log(entity.attributes) // [{key: "...", value: "..."}]

// Query multiple entities
const query = publicClient.buildQuery()
const result = await query
  .where(eq("type", "image"))
  .ownedBy("0xOwnerAddress...")
  .withAttributes(true)
  .withPayload(false)  // false = metadata only (faster)
  .limit(50)
  .fetch()

console.log(result.entities)
```

### Basic Writing Example

```typescript
import { createWalletClient, http } from "@arkiv-network/sdk"
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts"
import { mendoza } from "@arkiv-network/sdk/chains"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"

const walletClient = createWalletClient({
  chain: mendoza,
  transport: http(),
  account: privateKeyToAccount("0xYourPrivateKey..."),
})

const { entityKey, txHash } = await walletClient.createEntity({
  payload: jsonToPayload({ title: "Hello", content: "World" }),
  contentType: "application/json",
  attributes: [
    { key: "type", value: "document" },
    { key: "version", value: "1" },
  ],
  expiresIn: ExpirationTime.fromDays(30),
})
```

## Custom Chain Configuration

If using a custom RPC or chain not in the SDK:

```typescript
import { createPublicClient, http } from "@arkiv-network/sdk"
import { defineChain } from "viem"

const customChain = defineChain({
  id: 60138453056,
  name: "Mendoza",
  network: "mendoza",
  nativeCurrency: {
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [process.env.RPC_URL],
    },
  },
  testnet: true,
})

const publicClient = createPublicClient({
  chain: customChain,
  transport: http(),
})
```

## Query Builder Reference

### Import Query Operators

```typescript
import { eq, lt, lte, gt, gte, or, and } from "@arkiv-network/sdk/query"
```

### Filter by Attributes

```typescript
const query = publicClient.buildQuery()

// Single condition
query.where(eq("type", "image"))

// Multiple conditions (AND)
query.where(eq("type", "image")).where(eq("category", "cats"))

// OR conditions
query.where(or([eq("status", "active"), eq("status", "pending")]))

// Numeric comparisons
query.where(gt("priority", 5))
query.where(gte("score", 80))
query.where(lt("id", 1000))
query.where(lte("count", 50))

// Range query
query.where(gte("score", 80)).where(lte("score", 100))
```

### Filter by Owner

```typescript
query.ownedBy("0x33f855221a45C3d4BF8334b20f802DcdeE5B965A")
```

### Control Response Data

```typescript
// Include attributes in response
query.withAttributes(true)

// Include payload (binary data) - USE CAREFULLY for large data
query.withPayload(true)   // true = include binary payload
query.withPayload(false)  // false = metadata only (faster, less bandwidth)
```

### Sorting

```typescript
// Sort by numeric attribute descending (newest first)
query.orderBy("id", "number", "desc")

// Sort ascending
query.orderBy("created", "number", "asc")

// Sort by string attribute
query.orderBy("name", "string", "asc")
```

### Limiting Results

```typescript
query.limit(50)  // Return max 50 entities
```

### Execute Query

```typescript
const result = await query.fetch()
console.log(result.entities)  // Array of entities
```

## Pagination

### SDK Native Pagination (RECOMMENDED)

The SDK provides built-in pagination via `result.next()`. This is the most reliable method:

```typescript
const query = publicClient.buildQuery()
const result = await query
  .ownedBy(OWNER_ADDRESS)
  .withPayload(false)
  .withAttributes(true)
  .orderBy("id", "number", "desc")
  .limit(50)
  .fetch()

// First page
console.log(result.entities)

// Check for more pages
if (result.hasNextPage()) {
  await result.next()
  // result.entities now contains the NEXT page
  console.log(result.entities)
}

// Loop through all pages
while (result.hasNextPage()) {
  await result.next()
  console.log(`Page loaded: ${result.entities.length} entities`)
}
```

### Server-Side Session Pagination Pattern

For web applications, store the `result` object in memory and provide pagination via API:

```typescript
// Session cache
const sessionCache = new Map<string, { result: any; createdAt: number }>()

// Create new session (first page)
async function createSession(perPage: number) {
  const query = publicClient.buildQuery()
  const result = await query
    .ownedBy(OWNER_ADDRESS)
    .withPayload(false)
    .withAttributes(true)
    .orderBy("id", "number", "desc")
    .limit(perPage)
    .fetch()

  const sessionId = crypto.randomUUID()
  sessionCache.set(sessionId, { result, createdAt: Date.now() })

  return {
    sessionId,
    entities: result.entities,
    hasMore: result.hasNextPage(),
  }
}

// Get next page
async function getNextPage(sessionId: string) {
  const session = sessionCache.get(sessionId)
  if (!session || !session.result.hasNextPage()) return null

  await session.result.next()
  return {
    entities: session.result.entities,
    hasMore: session.result.hasNextPage(),
  }
}
```

### WARNING: Avoid Cursor-Based Pagination with Filters

**DO NOT** combine `orderBy()` with filter operators like `lt()` for pagination:

```typescript
// ❌ BAD - This causes timeouts on ARKIV RPC
query
  .orderBy("id", "number", "desc")
  .where(lt("id", lastSeenId))  // TIMEOUT!
  .limit(50)
  .fetch()

// ✅ GOOD - Use SDK native pagination
const result = await query.orderBy("id", "number", "desc").limit(50).fetch()
if (result.hasNextPage()) {
  await result.next()  // This works correctly
}
```

## Working with Payloads

### Reading JSON Payload

```typescript
const entity = await publicClient.getEntity("0x...")
const data = JSON.parse(Buffer.from(entity.payload).toString())
```

### Reading Binary Payload (Images, Files)

```typescript
const entity = await publicClient.getEntity("0x...")
const buffer = Buffer.from(entity.payload)

// For HTTP response
res.writeHead(200, {
  "Content-Type": "image/png",
  "Content-Length": buffer.length.toString(),
})
res.end(buffer)
```

### Writing JSON Payload

```typescript
import { jsonToPayload } from "@arkiv-network/sdk/utils"

await walletClient.createEntity({
  payload: jsonToPayload({ key: "value" }),
  contentType: "application/json",
  // ...
})
```

### Writing Binary Payload

```typescript
const imageBuffer = fs.readFileSync("image.png")

await walletClient.createEntity({
  payload: imageBuffer,
  contentType: "image/png",
  // ...
})
```

## Parsing Entity Attributes

Entities return attributes as an array. Helper function to extract values:

```typescript
interface Entity {
  key: string
  attributes: Array<{ key: string; value: string | number }>
  payload?: Uint8Array
}

function getAttr(entity: Entity, attrKey: string): string | number | undefined {
  return entity.attributes?.find((a) => a.key === attrKey)?.value
}

// Usage
const entity = await publicClient.getEntity("0x...")
const type = getAttr(entity, "type")      // "image"
const id = getAttr(entity, "id")          // 123
const prompt = getAttr(entity, "prompt")  // "a cute cat..."
```

## Expiration Times

```typescript
import { ExpirationTime } from "@arkiv-network/sdk/utils"

ExpirationTime.fromMinutes(30)   // 30 minutes
ExpirationTime.fromHours(24)     // 24 hours
ExpirationTime.fromDays(7)       // 7 days
ExpirationTime.fromDays(365)     // 1 year

// No expiration - omit expiresIn parameter
await walletClient.createEntity({
  payload: jsonToPayload(data),
  contentType: "application/json",
  attributes: [...],
  // expiresIn: not specified = permanent
})
```

## Best Practices

### 1. Always Use withPayload(false) for Listings

```typescript
// ✅ GOOD - Fast, low bandwidth
const result = await query
  .withPayload(false)  // Only metadata
  .withAttributes(true)
  .limit(100)
  .fetch()

// Load full payload only when needed
const fullEntity = await publicClient.getEntity(result.entities[0].key)
```

### 2. Use Limits

```typescript
// ✅ GOOD
query.limit(50).fetch()

// ❌ BAD - May return thousands of entities
query.fetch()
```

### 3. Cache Results

```typescript
let cachedData: Entity[] | null = null
let cacheTime = 0
const CACHE_TTL = 60_000 // 1 minute

async function getData() {
  if (cachedData && Date.now() - cacheTime < CACHE_TTL) {
    return cachedData
  }
  cachedData = await fetchFromArkiv()
  cacheTime = Date.now()
  return cachedData
}
```

### 4. Error Handling

```typescript
try {
  const result = await query.fetch()
} catch (error) {
  if (error.message.includes("timeout")) {
    // RPC timeout - simplify query or use pagination
  }
  console.error("ARKIV error:", error.message)
}
```

### 5. Index with Attributes

Design attributes for efficient querying:

```typescript
// ✅ GOOD - Easy to filter
attributes: [
  { key: "app", value: "MyApp" },
  { key: "type", value: "image" },
  { key: "id", value: 123 },
  { key: "category", value: "cats" },
]

// Query efficiently
query.where(eq("app", "MyApp")).where(eq("type", "image"))
```

## Debugging

Enable verbose logging:

```bash
DEBUG=arkiv:* node server.js
DEBUG=arkiv:rpc node server.js   # Only RPC logs
DEBUG=arkiv:query node server.js # Only query logs
```

## Complete Web Server Example

```typescript
import { createServer } from "node:http"
import { createPublicClient, http } from "@arkiv-network/sdk"
import { mendoza } from "@arkiv-network/sdk/chains"

const publicClient = createPublicClient({
  chain: mendoza,
  transport: http(),
})

const OWNER = "0x33f855221a45C3d4BF8334b20f802DcdeE5B965A"

// Session storage for pagination
const sessions = new Map()

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")

  if (url.pathname === "/api/images") {
    const sessionId = url.searchParams.get("sessionId")
    const limit = parseInt(url.searchParams.get("limit") || "50")

    try {
      let data

      if (sessionId && sessions.has(sessionId)) {
        // Continue existing session
        const session = sessions.get(sessionId)
        if (session.result.hasNextPage()) {
          await session.result.next()
        }
        data = {
          images: session.result.entities,
          sessionId,
          hasMore: session.result.hasNextPage(),
        }
      } else {
        // New session
        const query = publicClient.buildQuery()
        const result = await query
          .ownedBy(OWNER)
          .withPayload(false)
          .withAttributes(true)
          .orderBy("id", "number", "desc")
          .limit(limit)
          .fetch()

        const newSessionId = crypto.randomUUID()
        sessions.set(newSessionId, { result, createdAt: Date.now() })

        data = {
          images: result.entities,
          sessionId: newSessionId,
          hasMore: result.hasNextPage(),
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(data))
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: error.message }))
    }
    return
  }

  if (url.pathname === "/api/image") {
    const key = url.searchParams.get("key")
    try {
      const entity = await publicClient.getEntity(key)
      if (entity?.payload) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": entity.payload.length.toString(),
        })
        res.end(Buffer.from(entity.payload))
      } else {
        res.writeHead(404)
        res.end("Not found")
      }
    } catch {
      res.writeHead(500)
      res.end("Error")
    }
    return
  }

  res.writeHead(404)
  res.end("Not found")
}).listen(8080)
```

## Resources

- **SDK Repository**: https://github.com/arkiv-network/arkiv-sdk-js
- **Testnet Faucet**: https://mendoza.hoodi.arkiv.network/faucet/
- **Block Explorer**: https://explorer.mendoza.hoodi.arkiv.network
- **Documentation**: https://docs.arkiv.network

## Mendoza Testnet Info

- **Chain ID**: 60138453056
- **Network**: Mendoza (testnet)
- **Native Currency**: ETH (18 decimals)
- **RPC URL**: https://mendoza.hoodi.arkiv.network/rpc
