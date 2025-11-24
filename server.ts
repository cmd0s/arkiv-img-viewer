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
const PORT = 3000
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

interface ImageMeta {
  key: string
  id: string
  prompt: string
}

// Session cache for pagination results
interface PaginationSession {
  result: any
  currentPage: number
  perPage: number
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

// Parse entities into ImageMeta
function parseEntities(entities: any[]): ImageMeta[] {
  return entities.map((entity) => {
    const attrs = entity.attributes || []
    return {
      key: entity.key,
      id: String(attrs.find((a: any) => a.key === "id")?.value || ""),
      prompt: String(attrs.find((a: any) => a.key === "prompt")?.value || ""),
    }
  })
}

// Create new pagination session
async function createSession(perPage: number): Promise<{ sessionId: string; images: ImageMeta[]; hasMore: boolean }> {
  const query = publicClient.buildQuery()
  const result = await query
    .ownedBy(OWNER_ADDRESS)
    .withPayload(false)
    .withAttributes(true)
    .orderBy("id", "number", "desc")
    .limit(perPage)
    .fetch()

  const sessionId = randomBytes(8).toString("hex")
  sessionCache.set(sessionId, {
    result,
    currentPage: 1,
    perPage,
    createdAt: Date.now(),
  })

  return {
    sessionId,
    images: parseEntities(result.entities),
    hasMore: result.hasNextPage(),
  }
}

// Get next page from existing session
async function getNextPage(sessionId: string): Promise<{ images: ImageMeta[]; hasMore: boolean } | null> {
  const session = sessionCache.get(sessionId)
  if (!session) return null

  if (!session.result.hasNextPage()) {
    return { images: [], hasMore: false }
  }

  await session.result.next()
  session.currentPage++
  session.createdAt = Date.now() // Refresh TTL

  return {
    images: parseEntities(session.result.entities),
    hasMore: session.result.hasNextPage(),
  }
}

// Fetch single image by key
async function fetchImage(key: string): Promise<Buffer | null> {
  try {
    const entity = await publicClient.getEntity(key)
    if (entity?.payload) {
      return Buffer.from(entity.payload)
    }
    return null
  } catch {
    return null
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)

  // List of images with SDK pagination
  if (url.pathname === "/api/images") {
    try {
      const sessionId = url.searchParams.get("sessionId")
      const limitParam = url.searchParams.get("limit")
      const perPage = limitParam ? Math.min(parseInt(limitParam), 1000) : 50

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
