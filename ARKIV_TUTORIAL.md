# Arkiv SDK Tutorial

This tutorial will guide you through setting up and using the Arkiv SDK for JavaScript/TypeScript to interact with the Arkiv blockchain network. You'll learn how to query existing data and create new entities on the blockchain.

## What is Arkiv?

Arkiv is a blockchain network that allows you to store and query structured data with attributes and expiration times. Think of it as a decentralized database where each entry (entity) has:
- A unique key
- JSON payload data
- Key-value attributes for filtering
- Optional expiration time
- Owner information

## Prerequisites

- **Node.js 22.10.0+** or **Bun** (recommended for native TypeScript support)
- Basic knowledge of TypeScript/JavaScript
- A text editor or IDE

## Step 1: Project Setup

Create a new project directory:

```bash
mkdir arkiv-tutorial
cd arkiv-tutorial
```

Initialize your project:

```bash
npm init -y
```

Install the Arkiv SDK:

```bash
npm install @arkiv-network/sdk
```

Configure your `package.json` for ES modules:

```json
{
  "type": "module",
  "main": "index.ts"
}
```

## Step 2: Reading Data (Public Client)

Create `read-example.ts`:

```typescript
import { createPublicClient, http } from "@arkiv-network/sdk"
import { mendoza } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"

// Create a public client
const publicClient = createPublicClient({
  chain: mendoza, // Arkiv testnet for DevConnect 2025 hackathons
  transport: http(),
})

// Get chain ID
const chainId = await publicClient.getChainId()
console.log("Chain ID:", chainId)

// Get entity by key
const entity = await publicClient.getEntity(
  "0xcadb830a3414251d65e5c92cd28ecb648d9e73d85f2203eff631839d5421f9d7"
)
console.log("Entity:", entity)

// Build and execute a query using QueryBuilder
const query = publicClient.buildQuery()
const result = await query
  .where(eq("category", "documentation"))
  .ownedBy("0x6186B0DbA9652262942d5A465d49686eb560834C")
  .withAttributes(true)
  .withPayload(true)
  .limit(10)
  .fetch()

console.log("Found entities:", result.entities)

// Pagination - fetch next page
if (result.hasNextPage()) {
  await result.next()
  console.log("Next page:", result.entities)
}
```

### Key Concepts in the Read Example:

1. **Public Client**: Read-only access to blockchain data
2. **Chain Configuration**: Uses `mendoza` testnet
3. **Entity Lookup**: Get specific entity by its unique key
4. **Query Builder**: Powerful filtering and pagination system
   - `where()`: Filter by attribute values
   - `ownedBy()`: Filter by owner address
   - `withAttributes()`: Include attribute data
   - `withPayload()`: Include payload data
   - `limit()`: Restrict number of results
   - `fetch()`: Execute the query

## Step 3: Writing Data (Wallet Client)

Create `write-example.ts`:

```typescript
import { createPublicClient, createWalletClient, http } from "@arkiv-network/sdk"
import { privateKeyToAccount } from "@arkiv-network/sdk/accounts"
import { mendoza } from "@arkiv-network/sdk/chains"
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk/utils"

// Create a public client (for reading after write)
const publicClient = createPublicClient({
  chain: mendoza,
  transport: http(),
})

// Create a wallet client with an account
const client = createWalletClient({
  chain: mendoza,
  transport: http(),
  account: privateKeyToAccount("0x..."), // Replace with your private key
})

// Create an entity
const { entityKey, txHash } = await client.createEntity({
  payload: jsonToPayload({
    entity: {
      entityType: "document",
      entityId: "doc-123",
      entityContent:
        "Hello from DevConnect Hackathon 2025! Arkiv Mendoza chain wish you all the best!",
    },
  }),
  contentType: "application/json",
  attributes: [
    { key: "category", value: "documentation" },
    { key: "version", value: "1.0" },
  ],
  expiresIn: ExpirationTime.fromDays(30), // Entity expires in 30 days
})

console.log("Created entity:", entityKey)
console.log("Transaction hash:", txHash)

// Verify the entity was created
const newEntity = await publicClient.getEntity(entityKey)
console.log("Entity:", newEntity)
```

### Key Concepts in the Write Example:

1. **Wallet Client**: Enables blockchain transactions (requires private key)
2. **Account Creation**: Convert private key to account object
3. **Entity Creation**: Store structured data with metadata
   - `payload`: The actual data (JSON converted to bytes)
   - `contentType`: MIME type for the payload
   - `attributes`: Key-value pairs for filtering
   - `expiresIn`: When the entity should be deleted
4. **Transaction Result**: Returns entity key and transaction hash

## Step 4: Running Your Examples

Choose your preferred method:

### Option A: Using Bun (Recommended)
```bash
bun read-example.ts
bun write-example.ts
```

### Option B: Using Node.js with TypeScript Support
```bash
node --experimental-strip-types read-example.ts
node --experimental-strip-types write-example.ts
```

### Option C: Traditional TypeScript Compilation
```bash
npm install typescript
npx tsc --init
npx tsc --outDir dist
node dist/read-example.js
node dist/write-example.js
```

## Step 5: Getting Test Funds

To create entities, you need a funded wallet:

1. **Generate a Private Key**: Use [vanity-eth.tk](https://vanity-eth.tk/) or any key generator
2. **Fund Your Address**: Visit the [Arkiv Mendoza Faucet](https://mendoza.hoodi.arkiv.network/faucet/)
3. **Update Your Code**: Replace `"0x..."` with your actual private key

**Quick Test Key** (may not always have funds):
```
0x3d05798f7d11bb1c10b83fed8d3b4d76570c31cd66c8e0a8d8d991434c6d7a5e
```

## Advanced Query Examples

### Filter by Multiple Attributes
```typescript
const result = await query
  .where(eq("category", "documentation"))
  .where(eq("version", "1.0"))
  .limit(5)
  .fetch()
```

### Search by Owner
```typescript
const userEntities = await query
  .ownedBy("0x6186B0DbA9652262942d5A465d49686eb560834C")
  .withPayload(true)
  .fetch()
```

### Pagination Through Results
```typescript
let hasMore = true
let page = 1

while (hasMore) {
  console.log(`Page ${page}:`)
  console.log(result.entities)

  if (result.hasNextPage()) {
    await result.next()
    page++
  } else {
    hasMore = false
  }
}
```

## Common Use Cases

### 1. Document Storage System
```typescript
await client.createEntity({
  payload: jsonToPayload({
    title: "My Document",
    content: "Document content here...",
    author: "Jane Doe"
  }),
  attributes: [
    { key: "type", value: "document" },
    { key: "author", value: "jane-doe" }
  ],
  expiresIn: ExpirationTime.fromDays(365)
})
```

### 2. Event Logging
```typescript
await client.createEntity({
  payload: jsonToPayload({
    event: "user_login",
    userId: "12345",
    timestamp: new Date().toISOString()
  }),
  attributes: [
    { key: "event_type", value: "auth" },
    { key: "user_id", value: "12345" }
  ],
  expiresIn: ExpirationTime.fromDays(90)
})
```

### 3. Configuration Management
```typescript
await client.createEntity({
  payload: jsonToPayload({
    feature_flags: {
      darkMode: true,
      betaFeatures: false
    }
  }),
  attributes: [
    { key: "type", value: "config" },
    { key: "environment", value: "production" }
  ]
  // No expiration - configs should persist
})
```

## Debugging and Logging

Enable verbose logging with the `DEBUG` environment variable:

```bash
DEBUG=arkiv:* bun read-example.ts
DEBUG=arkiv:rpc bun write-example.ts  # Only RPC logs
DEBUG=arkiv:query bun read-example.ts  # Only query logs
```

## Next Steps

- Explore the [main repository](https://github.com/arkiv-network/arkiv-sdk-js) for more examples
- Read the [API documentation](https://docs.arkiv.network) for detailed reference
- Join the [Arkiv community](https://discord.gg/arkiv) for support and discussions
- Check out [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute to the SDK

## Troubleshooting

### Common Issues:

1. **"Module not found"**: Ensure you've installed dependencies with `npm install`
2. **"Cannot use import statement"**: Set `"type": "module"` in package.json
3. **"Insufficient funds"**: Fund your wallet using the testnet faucet
4. **Connection errors**: Check your internet connection and try again

### Getting Help:

- Check existing [GitHub Issues](https://github.com/arkiv-network/arkiv-sdk-js/issues)
- Create a new issue with your error details
- Join the community Discord for real-time support