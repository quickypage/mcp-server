# @quickypage/mcp-server

An [MCP](https://modelcontextprotocol.io) server for [Quicky.Page](https://quicky.page) — instant publishing for AI-generated web content.

Lets any MCP-compatible AI client (Claude Desktop, Cursor, custom orchestrators) publish a shareable web page in one tool call. Quicky.Page is the publishing primitive for AI-generated web artifacts: a single shareable web object, NOT a website builder, NOT a CMS, NOT a deployment platform.

## Tools

- **`publish_page`** — publish markdown (or qp.v1 blocks) as a public web page. Returns `{ url, id, editKey }`.
- **`update_page`** — update a previously-published page using its `editKey`. Same URL, replaced content.
- **`get_page`** — read the public content of a page by id.

## Install (Claude Desktop)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "npx",
      "args": ["-y", "@quickypage/mcp-server"]
    }
  }
}
```

Restart Claude Desktop. Ask: "Publish this as a Quicky.Page" — the agent will call `publish_page` and return a public URL.

## Install (Cursor)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "npx",
      "args": ["-y", "@quickypage/mcp-server"]
    }
  }
}
```

## Configuration

Set `QUICKYPAGE_BASE_URL` to point at a non-production deployment (preview, staging, or local Next.js dev server):

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "npx",
      "args": ["-y", "@quickypage/mcp-server"],
      "env": { "QUICKYPAGE_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

Defaults to `https://quicky.page`.

## Run from source

```bash
git clone https://github.com/quickypage/mcp-server
cd mcp-server
npm install
npm run build
node dist/server.js
```

The compiled binary at `dist/server.js` is the same one published to npm. Point any MCP client at the absolute path of that file:

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/server.js"]
    }
  }
}
```

## License

MIT — see [LICENSE](./LICENSE).
