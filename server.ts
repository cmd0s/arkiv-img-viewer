import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { config } from "dotenv"
import { createPublicClient, http } from "@arkiv-network/sdk"
import { eq, gt, lte } from "@arkiv-network/sdk/query"
import { defineChain } from "viem"

config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 8080
const OWNER_ADDRESS = process.env.ACCOUNT_ADR!
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

// Cache
let cachedMaxId: number | null = null
const PAGE_SIZE = 50

type ProgressCallback = (status: string, count?: number) => void

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

// Find max ID - simple approach: fetch batch and find max locally
async function findMaxId(onProgress?: ProgressCallback): Promise<number> {
  onProgress?.("Finding newest images...")

  // If we have cached max, just check for newer items (1 query)
  if (cachedMaxId !== null) {
    const checkQuery = publicClient.buildQuery()
    const checkResult = await checkQuery
      .where(eq("app", "CCats"))
      .where(eq("type", "image"))
      .where(gt("id", cachedMaxId))
      .ownedBy(OWNER_ADDRESS)
      .withAttributes(true)
      .withPayload(false)
      .limit(100)
      .fetch()

    if (checkResult.entities.length > 0) {
      const newImages = parseEntities(checkResult.entities)
      const newMax = Math.max(...newImages.map((i) => parseInt(i.id) || 0))
      cachedMaxId = Math.max(cachedMaxId, newMax)
      console.log(`Updated max ID: ${cachedMaxId}`)
    }
    return cachedMaxId
  }

  // No cache - fetch first batch and find max (1 query)
  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(200)
    .fetch()

  const images = parseEntities(result.entities)
  cachedMaxId = images.length > 0 ? Math.max(...images.map((i) => parseInt(i.id) || 0)) : 0
  console.log(`Found max ID: ${cachedMaxId}`)
  return cachedMaxId
}

// Estimate total from max ID (fast - no extra queries)
function estimateTotal(): number {
  // For sequential IDs, max ID ≈ total count
  // This is an estimate but avoids expensive full scan
  return cachedMaxId || 0
}

// Fetch images in reverse order (newest first) using ID range queries
async function fetchImagesReverse(
  page: number,
  perPage: number,
  onProgress?: ProgressCallback
): Promise<{ images: ImageMeta[]; total: number; totalPages: number }> {
  onProgress?.("Connecting to ARKIV...")

  // Find max ID first (cached after first call)
  const maxId = await findMaxId(onProgress)

  // Calculate ID range for this page (descending)
  // Page 1 = IDs from maxId down to maxId-perPage+1
  // Page 2 = IDs from maxId-perPage down to maxId-2*perPage+1
  const upperBound = maxId - (page - 1) * perPage
  const lowerBound = Math.max(0, upperBound - perPage) // Never go below 0

  onProgress?.(`Loading images ${lowerBound + 1} to ${upperBound}...`)

  // Query for IDs in this range: lowerBound < id <= upperBound
  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .where(gt("id", lowerBound))
    .where(lte("id", upperBound))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(perPage + 10) // Get a bit more in case of gaps
    .fetch()

  let images = parseEntities(result.entities)

  // Get more if needed and available
  while (images.length < perPage && result.hasNextPage()) {
    await result.next()
    images = images.concat(parseEntities(result.entities))
  }

  // Fallback: if range query returned nothing but we expect data,
  // IDs might still be strings - fall back to full fetch
  if (images.length === 0 && page === 1 && maxId > 0) {
    onProgress?.("Falling back to full load (IDs still migrating)...")
    const allImages = await fetchAllImages(onProgress)
    const total = allImages.length
    const totalPages = Math.ceil(total / perPage)
    const start = (page - 1) * perPage
    return {
      images: allImages.slice(start, start + perPage),
      total,
      totalPages,
    }
  }

  // Sort by ID descending (newest first) and limit to perPage
  images.sort((a, b) => (parseInt(b.id) || 0) - (parseInt(a.id) || 0))
  images = images.slice(0, perPage)

  // Estimate total from max ID (no extra query)
  const total = estimateTotal()
  const totalPages = Math.ceil(total / perPage)

  onProgress?.("Complete", images.length)
  return { images, total, totalPages }
}

// Fetch ALL images (needed for search)
async function fetchAllImages(onProgress?: ProgressCallback): Promise<ImageMeta[]> {
  onProgress?.("Loading all images for search...")

  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(PAGE_SIZE)
    .fetch()

  let allImages = parseEntities(result.entities)
  let pageNum = 1
  onProgress?.(`Loading page ${pageNum}...`, allImages.length)

  while (result.hasNextPage()) {
    pageNum++
    await result.next()
    allImages = allImages.concat(parseEntities(result.entities))
    onProgress?.(`Loading page ${pageNum}...`, allImages.length)
  }

  // Sort by ID descending
  allImages.sort((a, b) => (parseInt(b.id) || 0) - (parseInt(a.id) || 0))

  // Update max ID cache
  if (allImages.length > 0) {
    cachedMaxId = parseInt(allImages[0].id) || 0
  }

  onProgress?.("Complete", allImages.length)
  return allImages
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

  // SSE endpoint for real-time progress
  if (url.pathname === "/api/images/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    const sendEvent = (type: string, data: object) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const page = parseInt(url.searchParams.get("page") || "1")
      const perPage = parseInt(url.searchParams.get("perPage") || "50")
      const search = (url.searchParams.get("search") || "").toLowerCase().trim()

      if (search) {
        // Search requires fetching ALL images to filter
        sendEvent("progress", { status: "Search requires loading all data...", count: 0 })

        const images = await fetchAllImages((status, count) => {
          sendEvent("progress", { status, count: count || 0 })
        })

        sendEvent("progress", { status: "Filtering results...", count: images.length })
        const filtered = images.filter((img) => img.prompt.toLowerCase().includes(search))

        const total = filtered.length
        const totalPages = Math.ceil(total / perPage)
        const start = (page - 1) * perPage
        const paginatedImages = filtered.slice(start, start + perPage)

        sendEvent("complete", {
          images: paginatedImages,
          pagination: { page, perPage, total, totalPages },
        })
      } else {
        // No search - use reverse pagination (newest first)
        const { images, total, totalPages } = await fetchImagesReverse(
          page,
          perPage,
          (status, count) => sendEvent("progress", { status, count: count || 0 })
        )

        sendEvent("complete", {
          images,
          pagination: { page, perPage, total, totalPages },
        })
      }
    } catch (error) {
      console.error("Error in SSE:", error)
      sendEvent("error", { error: "Failed to fetch images" })
    }

    res.end()
    return
  }

  // List of images with pagination and search
  if (url.pathname === "/api/images") {
    try {
      const page = parseInt(url.searchParams.get("page") || "1")
      const perPage = parseInt(url.searchParams.get("perPage") || "100")
      const search = (url.searchParams.get("search") || "").toLowerCase().trim()

      if (search) {
        // Search requires all images
        const images = await fetchAllImages()
        const filtered = images.filter((img) => img.prompt.toLowerCase().includes(search))
        const total = filtered.length
        const totalPages = Math.ceil(total / perPage)
        const start = (page - 1) * perPage
        const paginatedImages = filtered.slice(start, start + perPage)

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images: paginatedImages,
          pagination: { page, perPage, total, totalPages },
        }))
      } else {
        // Reverse pagination (newest first)
        const { images, total, totalPages } = await fetchImagesReverse(page, perPage)

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          images,
          pagination: { page, perPage, total, totalPages },
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
          "Access-Control-Expose-Headers": "Content-Length",
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
