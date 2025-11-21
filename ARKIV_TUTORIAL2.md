## Perform multiple operations efficiently with Promise.all.


```typescript
// Create multiple entities in parallel
const createPromises = Array.from({ length: 10 }, (_, i) =>
  walletClient.createEntity({
    payload: jsonToPayload({ content: `Batch item ${i}` }),
    contentType: 'application/json',
    attributes: [
      { key: 'type', value: 'batch' },
      { key: 'index', value: i }
    ],
    expiresIn: ExpirationTime.fromMinutes(30),
  })
)

const results = await Promise.all(createPromises)
console.log(`✅ Created ${results.length} entities`)

// Query all batch items
const query = publicClient.buildQuery()
const batchItems = await query
  .where(eq('type', 'batch'))
  .withPayload(true)
  .fetch()
console.log(`📊 Found ${batchItems.length} batch items`)
```




## Complex Queries

```typescript
import { and, or, lt } from "@arkiv-network/sdk/query"

// Complex conditions with grouping
const query1 = publicClient.buildQuery()
const results1 = await query1
  .where(or([
    and([eq('type', 'message'), gt('priority', 3)]),
    eq('status', 'urgent')
  ]))
  .fetch()

// Date range queries
const query2 = publicClient.buildQuery()
const results2 = await query2
  .where(gt('created', 1672531200))
  .where(lt('created', 1672617600))
  .fetch()
```


## Best Practices

### Efficient Querying
```typescript
  // ✅ Good: Specific queries with query builder
const query = publicClient.buildQuery()
const notes = await query
  .where(eq('type', 'note'))
  .where(gt('priority', 3))
  .limit(100)
  .fetch()

// ❌ Avoid: Queries without limits
const all = await publicClient.buildQuery()
  .where(eq('type', 'note'))
  .fetch() // May return too many results
```

### Proper Expires In Management

```typescript
import { ExpirationTime } from "@arkiv-network/sdk/utils"

// ✅ Good: Use ExpirationTime helper
const sessionData = ExpirationTime.fromMinutes(30)
const dailyNotes = ExpirationTime.fromHours(12)
const weeklyBackup = ExpirationTime.fromDays(7)
```

### Error Handling

```typescript
// ✅ Good: Comprehensive error handling
try {
  const { entityKey } = await walletClient.createEntity({
    payload: jsonToPayload(data),
    contentType: 'application/json',
    attributes: [{ key: 'type', value: 'note' }],
    expiresIn: ExpirationTime.fromHours(24),
  })
} catch (error) {
  console.error('Operation failed:', error.message)
  // Handle specific error types
}
```