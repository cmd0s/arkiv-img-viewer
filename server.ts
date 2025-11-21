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
  size?: number
}

// Cache for image list
let cachedImages: ImageMeta[] | null = null
let cacheTime = 0
const CACHE_TTL = 60000 // 1 minute

// Fetch all images from Arkiv (with cache)
async function fetchAllImages(): Promise<ImageMeta[]> {
  const now = Date.now()
  if (cachedImages && now - cacheTime < CACHE_TTL) {
    return cachedImages
  }

  console.log("Fetching images from Arkiv...")
  const query = publicClient.buildQuery()
  const result = await query
    .where(eq("app", "CCats"))
    .where(eq("type", "image"))
    .ownedBy(OWNER_ADDRESS)
    .withAttributes(true)
    .withPayload(false)
    .limit(50)
    .fetch()

  const images: ImageMeta[] = []

  for (const entity of result.entities) {
    const attrs = entity.attributes || []
    const id = attrs.find((a) => a.key === "id")?.value || ""
    const prompt = attrs.find((a) => a.key === "prompt")?.value || ""
    images.push({ key: entity.key, id, prompt })
  }

  // Fetch all pages
  while (result.hasNextPage()) {
    await result.next()
    for (const entity of result.entities) {
      const attrs = entity.attributes || []
      const id = attrs.find((a) => a.key === "id")?.value || ""
      const prompt = attrs.find((a) => a.key === "prompt")?.value || ""
      images.push({ key: entity.key, id, prompt })
    }
  }

  // Sort by ID descending (newest first)
  images.sort((a, b) => {
    const idA = parseInt(a.id) || 0
    const idB = parseInt(b.id) || 0
    return idB - idA
  })

  cachedImages = images
  cacheTime = now
  console.log(`Cached ${images.length} images`)
  return images
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

  // List of images with pagination and search
  if (url.pathname === "/api/images") {
    try {
      const page = parseInt(url.searchParams.get("page") || "1")
      const perPage = parseInt(url.searchParams.get("perPage") || "100")
      const search = (url.searchParams.get("search") || "").toLowerCase().trim()

      let images = await fetchAllImages()

      // Filter by search term in prompt
      if (search) {
        images = images.filter((img) => img.prompt.toLowerCase().includes(search))
      }

      const total = images.length
      const totalPages = Math.ceil(total / perPage)
      const start = (page - 1) * perPage
      const end = start + perPage
      const paginatedImages = images.slice(start, end)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          images: paginatedImages,
          pagination: {
            page,
            perPage,
            total,
            totalPages,
          },
        })
      )
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

  // Image info (size) by key
  if (url.pathname === "/api/image/info") {
    const key = url.searchParams.get("key")
    if (!key) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Missing key parameter" }))
      return
    }
    try {
      const imageData = await fetchImage(key)
      if (imageData) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ key, size: imageData.length }))
      } else {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Image not found" }))
      }
    } catch (error) {
      console.error("Error fetching image info:", error)
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Failed to fetch image info" }))
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
