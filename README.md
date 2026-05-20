# @quickypage/mcp-server

An [MCP](https://modelcontextprotocol.io) server for [Quicky.Page](https://quicky.page) — instant publishing for AI-generated web content.

Lets any MCP-compatible AI client (Claude Desktop, Cursor, custom orchestrators) publish a shareable web page. Quicky.Page is the publishing primitive for AI-generated web artifacts: a single shareable web object, NOT a website builder, NOT a CMS, NOT a deployment platform.

## Status

This package is published to GitHub and is not published to npm yet. Run it from source for now.

## Tools

- **`publish_page`** — publish markdown or qp.v1 blocks as a public web page. Returns `{ url, editUrl, id, slug, editKey }`.
- **`upload_image`** — upload attached, generated, local, or hosted image bytes through Quicky.Page's signed upload flow. Returns `{ publicUrl, key, block }`, where `block` is ready for `publish_page` or `update_page`.
- **`update_page`** — replace a previously-published page using its `editKey`. Same URL, replaced content.
- **`rename_page_slug`** — set, change, or clear a premium custom URL slug.
- **`get_page`** — read the public content of a page by id.

## Image Workflow

For attached or generated images, call `upload_image` first with a MIME type (`image/png`, `image/jpeg`, `image/webp`, or `image/gif`) and exactly one image source:

- `data`: base64 bytes or a `data:image/...;base64,...` URL. Best for very small images only; some MCP hosts can hang or fail on larger inline tool arguments.
- `filePath`: a local file path readable by the MCP server. Preferred for Claude Desktop or other local MCP clients when the image can be saved to disk.
- `sourceUrl`: a hosted `http(s)` image URL. Preferred when the image is already reachable online.

For Claude Desktop attachments or generated images, ask Claude to save the image locally first and pass `filePath` instead of inline base64. Then include the returned `block` in a `blocks` array:

```json
{
  "title": "Launch poster",
  "blocks": [
    { "type": "richtext", "html": "<h1>Launch poster</h1><p>Generated in Claude.</p>" },
    { "type": "image", "url": "https://assets.example/poster.png", "alt": "Launch poster" }
  ]
}
```

Do not put raw base64 image data in page markdown or blocks. Images are uploaded once and referenced by URL.

## Edit Links

`publish_page` and `update_page` return both:

- `url`: public reader link.
- `editUrl`: one-click editor link in the form `https://quicky.page/?id=<id>#edit=<editKey>`.

Treat `editUrl` and `editKey` as secrets. Anyone with the edit URL can edit the page.

## Run from Source

```bash
git clone https://github.com/quickypage/mcp-server
cd mcp-server
npm install
npm run build
node dist/server.js
```

Point Claude Desktop or Cursor at the compiled `dist/server.js`:

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "node",
      "args": ["/absolute/path/to/quickypage-mcp-server/dist/server.js"]
    }
  }
}
```

## Configuration

Set `QUICKYPAGE_BASE_URL` to point at a non-production deployment:

```json
{
  "mcpServers": {
    "quickypage": {
      "command": "node",
      "args": ["/absolute/path/to/quickypage-mcp-server/dist/server.js"],
      "env": { "QUICKYPAGE_BASE_URL": "http://localhost:3000" }
    }
  }
}
```

Defaults to `https://quicky.page`.

Set `QUICKYPAGE_PREMIUM_TOKEN` only for operator environments that should be allowed to create or rename premium custom URL slugs.

## Account Login

This local stdio server does not log in as a Quicky.Page user or cloud-save pages to an account. Published pages are anonymous and editable through the returned `editUrl`/`editKey`.

Account-connected MCP is a future design that should use a deliberate OAuth or device-code flow, scoped tokens, revocation, and a server endpoint that claims a page to an account after verifying its `editKey`.

## License

MIT — see [LICENSE](./LICENSE).
