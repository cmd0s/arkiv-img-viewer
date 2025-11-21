## Query Language Reference


Arkiv provides a query builder API for entity retrieval:

### String Attributes

```typescript
import { eq, or } from "@arkiv-network/sdk/query"

// Exact match
const query1 = publicClient.buildQuery()
const results1 = await query1.where(eq('type', 'message')).fetch()

// Multiple conditions (AND)
const query2 = publicClient.buildQuery()
const results2 = await query2
  .where(eq('type', 'note'))
  .where(eq('category', 'work'))
  .fetch()

// OR conditions
const query3 = publicClient.buildQuery()
const results3 = await query3
  .where(or([eq('status', 'active'), eq('status', 'pending')]))
  .fetch()
```

### Numeric Attributes

```typescript
import { gt, gte, lte } from "@arkiv-network/sdk/query"

// Comparison operators
const query1 = publicClient.buildQuery()
const results1 = await query1.where(gt('priority', 5)).fetch()

// Range query
const query2 = publicClient.buildQuery()
const results2 = await query2
  .where(gte('score', 80))
  .where(lte('score', 100))
  .fetch()

// Combined conditions
const query3 = publicClient.buildQuery()
const results3 = await query3
  .where(gt('priority', 3))
  .where(eq('type', 'task'))
  .fetch()
```

### Complex Queries

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


### Entity Keys

```typescript
// Entity keys are Ethereum addresses
const entityKey = "0x1234567890abcdef1234567890abcdef12345678"

// Use entity keys to reference specific data
const entity = await publicClient.getEntity(entityKey)
const data = JSON.parse(entity.payload)
```
