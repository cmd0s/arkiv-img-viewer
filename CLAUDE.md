# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a web-based image gallery viewer for images stored on the ARKIV blockchain. It displays AI-generated cat images (CCats) that are uploaded by a separate Python application.

## Commands

```bash
# Install dependencies
npm install

# Start production server (port 8080)
npm start

# Start development server with auto-reload
npm run dev
```

Requires Node.js 22.10.0+ (uses `--experimental-strip-types` for native TypeScript execution).

## Architecture

### Backend (`server.ts`)
- Native Node.js HTTP server (no framework)
- Connects to ARKIV Mendoza testnet using `@arkiv-network/sdk`
- Defines custom chain config for Mendoza (chain ID: 60138453056)
- Caches image metadata for 1 minute to reduce RPC calls
- Images filtered by attributes: `app="CCats"`, `type="image"`, owned by address from `.env`

### API Endpoints
- `GET /` - Serves the HTML frontend
- `GET /api/images?page=1&perPage=100&search=term` - Paginated image metadata (no payload)
- `GET /api/image?key=0x...` - Single image binary by entity key

### Frontend (`public/index.html`)
- Single-file vanilla HTML/CSS/JS
- Lazy-loads images individually (avoids large payload responses)
- Features: pagination, keyword search in prompts, loading spinners, modal view

## Configuration

Environment variables in `.env`:
- `RPC_URL` - ARKIV Mendoza RPC endpoint
- `ACCOUNT_ADR` - Owner address for filtering images

## ARKIV SDK Usage

Query pattern for reading entities:
```typescript
const query = publicClient.buildQuery()
const result = await query
  .where(eq("attribute_key", "value"))
  .ownedBy(address)
  .withAttributes(true)
  .withPayload(false)  // false for metadata, true for image data
  .limit(50)
  .fetch()

// Pagination
while (result.hasNextPage()) {
  await result.next()
}
```

See `ARKIV_TUTORIAL.md` for full SDK documentation.
