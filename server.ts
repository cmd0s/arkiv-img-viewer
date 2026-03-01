import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { config } from "dotenv"
import { createPublicClient, http } from "@arkiv-network/sdk"
import { defineChain } from "viem"

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 8080
const OWNER_ADDRESS = process.env.ACCOUNT_ADR! as `0x${string}`
const RPC_URL = process.env.RPC_URL!

const mendoza = defineChain({
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
      http: [RPC_URL],
    },
  },
  testnet: true,
})

const publicClient = createPublicClient({
  chain: mendoza,
  transport: http(),
})

// Semaphore to limit concurrent RPC calls (Mendoza rate-limits at ~12)
const MAX_CONCURRENT_RPC = 8
let activeRpcCalls = 0
const rpcQueue: Array<() => void> = []

function acquireRpc(): Promise<void> {
  if (activeRpcCalls < MAX_CONCURRENT_RPC) {
    activeRpcCalls++
    return Promise.resolve()
  }
  return new Promise((resolve) => rpcQueue.push(resolve))
}

function releaseRpc(): void {
  const next = rpcQueue.shift()
  if (next) {
    next()
  } else {
    activeRpcCalls--
  }
}

// LRU image cache (max ~100MB assuming ~100KB per image)
const IMAGE_CACHE_MAX = 1000
const imageCache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  const val = imageCache.get(key)
  if (val) {
    // Move to end (most recently used)
    imageCache.delete(key)
    imageCache.set(key, val)
  }
  return val
}

function cacheSet(key: string, data: Buffer): void {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    // Evict oldest entry
    const oldest = imageCache.keys().next().value!
    imageCache.delete(oldest)
  }
  imageCache.set(key, data)
}

interface ImageMeta {
  key: string
  id: string
  prompt: string
}

// Session cache for cursor-based pagination
interface PaginationSession {
  cursor: string | null
  perPage: number
  currentPage: number
  createdAt: number
}

const sessionCache = new Map<string, PaginationSession>()
const SESSION_TTL = 5 * 60 * 1000 // 5 minutes

// Cleanup old sessions periodically
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessionCache) {
    if (now - session.createdAt > SESSION_TTL) {
      sessionCache.delete(id)
    }
  }
}, 60 * 1000)

// Parse raw RPC entities into ImageMeta
function parseRpcEntities(data: any[]): ImageMeta[] {
  return data.map((entity) => {
    const numAttrs = entity.numericAttributes || []
    const strAttrs = entity.stringAttributes || []
    return {
      key: entity.key,
      id: String(numAttrs.find((a: any) => a.key === "id")?.value ?? strAttrs.find((a: any) => a.key === "id")?.value ?? ""),
      prompt: String(strAttrs.find((a: any) => a.key === "prompt")?.value || ""),
    }
  })
}

// Query ARKIV using raw RPC to work around SDK 0.6.x hex encoding bug
async function queryImages(perPage: number, cursor?: string): Promise<{ images: ImageMeta[]; cursor: string | null }> {
  const options: any = {
    includeData: {
      key: true,
      attributes: true,
      payload: false,
    },
    resultsPerPage: perPage,
    orderBy: [{ name: "id", type: "numeric", desc: true }],
  }
  if (cursor) {
    options.cursor = cursor
  }

  const result = await publicClient.request({
    method: "arkiv_query" as any,
    params: [
      `$owner=${OWNER_ADDRESS}`,
      options,
    ],
  }) as any

  return {
    images: parseRpcEntities(result.data || []),
    cursor: result.cursor || null,
  }
}

// Create new pagination session
async function createSession(perPage: number): Promise<{ sessionId: string; images: ImageMeta[]; hasMore: boolean }> {
  const { images, cursor } = await queryImages(perPage)

  const sessionId = randomBytes(8).toString("hex")
  sessionCache.set(sessionId, {
    cursor,
    perPage,
    currentPage: 1,
    createdAt: Date.now(),
  })

  return {
    sessionId,
    images,
    hasMore: cursor !== null && images.length === perPage,
  }
}

// Get next page from existing session
async function getNextPage(sessionId: string): Promise<{ images: ImageMeta[]; hasMore: boolean } | null> {
  const session = sessionCache.get(sessionId)
  if (!session || !session.cursor) return null

  const { images, cursor } = await queryImages(session.perPage, session.cursor)
  session.cursor = cursor
  session.currentPage++
  session.createdAt = Date.now()

  return {
    images,
    hasMore: cursor !== null && images.length === session.perPage,
  }
}

// Fetch single image by key with concurrency control, caching, and retry
async function fetchImage(key: string): Promise<Buffer | null> {
  const cached = cacheGet(key)
  if (cached) return cached

  const MAX_RETRIES = 2
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireRpc()
    try {
      const entity = await publicClient.getEntity(key)
      if (entity?.payload) {
        const buf = Buffer.from(entity.payload)
        cacheSet(key, buf)
        return buf
      }
      return null
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.warn(`RPC retry ${attempt + 1}/${MAX_RETRIES} for ${key.slice(0, 16)}...`)
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        continue
      }
      console.error(`RPC failed after ${MAX_RETRIES + 1} attempts for ${key.slice(0, 16)}...:`, (err as Error).message)
      return null
    } finally {
      releaseRpc()
    }
  }
  return null
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)

  // List of images with SDK pagination
  if (url.pathname === "/api/images") {
    try {
      const sessionId = url.searchParams.get("sessionId")
      const limitParam = url.searchParams.get("limit")
      const perPage = limitParam ? Math.min(parseInt(limitParam), 200) : 50

      if (sessionId) {
        // Continue existing session
        const pageData = await getNextPage(sessionId)
        if (!pageData) {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Session not found or expired" }))
          return
        }

        console.log(`Session ${sessionId}: ${pageData.images.length} images, hasMore: ${pageData.hasMore}`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images: pageData.images,
          sessionId,
          hasMore: pageData.hasMore,
        }))
      } else {
        // New session
        const { sessionId: newSessionId, images, hasMore } = await createSession(perPage)

        console.log(`New session ${newSessionId}: ${images.length} images, hasMore: ${hasMore}`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images,
          sessionId: newSessionId,
          hasMore,
        }))
      }
    } catch (error) {
      console.error("Error fetching images:", error)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Failed to fetch images" }))
    }
    return
  }

  // Single image by key
  if (url.pathname === "/api/image") {
    const key = url.searchParams.get("key")
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Missing key parameter" }))
      return
    }
    try {
      const imageData = await fetchImage(key)
      if (imageData) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": imageData.length.toString(),
          "Cache-Control": "public, max-age=86400",
        })
        res.end(imageData)
      } else {
        res.writeHead(404)
        res.end("Image not found")
      }
    } catch (error) {
      console.error("Error fetching image:", error)
      res.writeHead(500)
      res.end("Error fetching image")
    }
    return
  }

  // Serve HTML
  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await readFile(join(__dirname, "public", "index.html"), "utf-8")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
    return
  }

  res.writeHead(404)
  res.end("Not found")
}

const server = createServer(handleRequest)

server.listen(PORT, () => {
  console.log(`Arkiv Image Viewer running at http://localhost:${PORT}`)
  console.log(`Owner: ${OWNER_ADDRESS}`)
})
