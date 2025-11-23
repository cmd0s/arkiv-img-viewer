import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
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

interface ImageMeta {
  key: string
  id: string
  prompt: string
}

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

// Fetch 50 newest images
async function fetchImages(): Promise<ImageMeta[]> {
  const query = publicClient.buildQuery()
  const result = await query
    .ownedBy(OWNER_ADDRESS)
    .withPayload(false)
    .withAttributes(true)
    .orderBy("id", "number", "desc")
    .limit(50)
    .fetch()

  return parseEntities(result.entities)
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

  // List of images
  if (url.pathname === "/api/images") {
    try {
      const images = await fetchImages()
      console.log(`Fetched ${images.length} images`)

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ images }))
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
