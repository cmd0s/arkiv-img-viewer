import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { config } from "dotenv"
import { createPublicClient, http } from "@arkiv-network/sdk"
import { eq } from "@arkiv-network/sdk/query"
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

// Cache for ARKIV pages (keyed by ARKIV page number)
const arkivPageCache: Map<number, ImageMeta[]> = new Map()
let totalArkivPages: number | null = null
let allImagesSorted: ImageMeta[] | null = null
let cacheTime = 0
const CACHE_TTL = 300000 // 5 minutes
const ARKIV_PAGE_SIZE = 50 // ARKIV's page size

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

// Fetch specific ARKIV pages needed for user's request (no search)
async function fetchPagesForRange(
  startIdx: number,
  endIdx: number,
  onProgress?: ProgressCallback
): Promise<{ images: ImageMeta[]; hasMore: boolean; totalFetched: number }> {
  const now = Date.now()
  const isCacheValid = now - cacheTime < CACHE_TTL

  // Calculate which ARKIV pages we need
  const startPage = Math.floor(startIdx / ARKIV_PAGE_SIZE) + 1
  const endPage = Math.floor((endIdx - 1) / ARKIV_PAGE_SIZE) + 1

  // Check if all needed pages are cached
  const neededPages: number[] = []
  for (let p = startPage; p <= endPage; p++) {
    if (!isCacheValid || !arkivPageCache.has(p)) {
      neededPages.push(p)
    }
  }

  if (neededPages.length === 0) {
    onProgress?.("Using cached data")
    // All pages cached, extract the range
    const allFromCache: ImageMeta[] = []
    for (let p = startPage; p <= endPage; p++) {
      allFromCache.push(...(arkivPageCache.get(p) || []))
    }
    const offsetInFirstPage = startIdx % ARKIV_PAGE_SIZE
    const count = endIdx - startIdx
    const images = allFromCache.slice(offsetInFirstPage, offsetInFirstPage + count)
    const hasMore = totalArkivPages !== null && endPage < totalArkivPages
    return { images, hasMore, totalFetched: startIdx + images.length }
  }

  // Need to fetch some pages
  if (!isCacheValid) {
    arkivPageCache.clear()
    totalArkivPages = null
    allImagesSorted = null
    cacheTime = now
  }

  onProgress?.("Connecting to ARKIV...")
  console.log(`Fetching ARKIV pages ${neededPages.join(", ")}...`)

  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(ARKIV_PAGE_SIZE)
    .fetch()

  let currentPage = 1
  arkivPageCache.set(currentPage, parseEntities(result.entities))
  onProgress?.(`Loaded page ${currentPage}`)

  // Navigate to the pages we need
  while (result.hasNextPage() && currentPage < endPage) {
    currentPage++
    await result.next()
    arkivPageCache.set(currentPage, parseEntities(result.entities))
    onProgress?.(`Loaded page ${currentPage}`)
  }

  // Check if there are more pages
  const hasMore = result.hasNextPage()
  if (!hasMore) {
    totalArkivPages = currentPage
  }

  // Extract the range we need
  const allFromCache: ImageMeta[] = []
  for (let p = startPage; p <= Math.min(endPage, currentPage); p++) {
    allFromCache.push(...(arkivPageCache.get(p) || []))
  }

  const offsetInFirstPage = startIdx % ARKIV_PAGE_SIZE
  const count = endIdx - startIdx
  const images = allFromCache.slice(offsetInFirstPage, offsetInFirstPage + count)

  onProgress?.("Complete", images.length)
  return { images, hasMore, totalFetched: startIdx + images.length }
}

// Fetch ALL images (needed for search)
async function fetchAllImages(onProgress?: ProgressCallback): Promise<ImageMeta[]> {
  const now = Date.now()

  // Return sorted cache if valid
  if (allImagesSorted && now - cacheTime < CACHE_TTL) {
    onProgress?.("Using cached data", allImagesSorted.length)
    return allImagesSorted
  }

  // Check if we have all pages cached
  if (totalArkivPages !== null && now - cacheTime < CACHE_TTL) {
    const allImages: ImageMeta[] = []
    for (let i = 1; i <= totalArkivPages; i++) {
      if (arkivPageCache.has(i)) {
        allImages.push(...arkivPageCache.get(i)!)
      } else {
        break // Missing page, need to refetch
      }
    }
    if (allImages.length > 0) {
      allImages.sort((a, b) => (parseInt(b.id) || 0) - (parseInt(a.id) || 0))
      allImagesSorted = allImages
      onProgress?.("Using cached data", allImages.length)
      return allImages
    }
  }

  // Need to fetch all
  onProgress?.("Connecting to ARKIV...")
  console.log("Fetching all images from ARKIV...")

  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(ARKIV_PAGE_SIZE)
    .fetch()

  arkivPageCache.clear()
  cacheTime = now

  let pageNum = 1
  arkivPageCache.set(pageNum, parseEntities(result.entities))
  onProgress?.(`Fetching page ${pageNum}...`, pageNum * ARKIV_PAGE_SIZE)

  while (result.hasNextPage()) {
    pageNum++
    await result.next()
    arkivPageCache.set(pageNum, parseEntities(result.entities))
    onProgress?.(`Fetching page ${pageNum}...`, pageNum * ARKIV_PAGE_SIZE)
  }

  totalArkivPages = pageNum

  // Combine all pages
  const allImages: ImageMeta[] = []
  for (let i = 1; i <= totalArkivPages; i++) {
    allImages.push(...(arkivPageCache.get(i) || []))
  }

  onProgress?.("Sorting results...", allImages.length)
  allImages.sort((a, b) => (parseInt(b.id) || 0) - (parseInt(a.id) || 0))
  allImagesSorted = allImages

  onProgress?.("Complete", allImages.length)
  console.log(`Fetched all ${allImages.length} images`)
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

      // Always fetch all images (sorted by ID desc - newest first)
      const allImages = await fetchAllImages((status, count) => {
        sendEvent("progress", { status, count: count || 0 })
      })

      let images = allImages

      // Filter by search if provided
      if (search) {
        sendEvent("progress", { status: "Filtering results...", count: allImages.length })
        images = allImages.filter((img) => img.prompt.toLowerCase().includes(search))
      }

      const total = images.length
      const totalPages = Math.ceil(total / perPage)
      const start = (page - 1) * perPage
      const paginatedImages = images.slice(start, start + perPage)

      sendEvent("complete", {
        images: paginatedImages,
        pagination: { page, perPage, total, totalPages },
      })
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

      // Always fetch all images (sorted by ID desc - newest first)
      const allImages = await fetchAllImages()
      let images = allImages

      if (search) {
        images = allImages.filter((img) => img.prompt.toLowerCase().includes(search))
      }

      const total = images.length
      const totalPages = Math.ceil(total / perPage)
      const start = (page - 1) * perPage
      const paginatedImages = images.slice(start, start + perPage)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        images: paginatedImages,
        pagination: { page, perPage, total, totalPages },
      }))
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
