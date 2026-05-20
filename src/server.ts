#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Quicky.Page MCP server.
//
// One job: let an AI agent publish a single shareable web page from a single
// tool call. Wraps the public HTTP API (`/api/v1/publish`) over stdio so any
// MCP-compatible client (Claude Desktop, Cursor, custom orchestrators) can
// expose Quicky.Page as a publishing primitive.
//
// Tool descriptions are deliberately worded to teach the LLM the product's
// positioning — "instant publishing for AI-generated content", "returns a
// public URL", explicitly NOT a website builder / CMS / deployment platform.
// The tool surface IS the discovery surface for any agent connected to this
// server, so the words here are part of the strategy, not flavor text.

const PACKAGE_NAME = "@quickypage/mcp-server";
const PACKAGE_VERSION = "0.1.0";

// Endpoint configuration. Defaults to production; override with env when
// pointing at a staging/preview deployment or a local Next.js dev server.
//
//   QUICKYPAGE_BASE_URL=http://localhost:3000 npx @quickypage/mcp-server
const DEFAULT_BASE_URL = "https://quicky.page";
const BASE_URL = (process.env.QUICKYPAGE_BASE_URL ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);

const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

// Premium feature gate: the HTTP API rejects custom-URL-slug requests
// unless the request carries a matching token (see lib/premium.ts).
// We forward whatever's in QUICKYPAGE_PREMIUM_TOKEN as `x-premium-token`
// on every outbound call so an authorized operator can claim slugs from
// any MCP-connected agent. When unset, premium-only calls fall through
// to the 403 the HTTP layer returns and surface as a tool-level error
// the agent can report verbatim.
const PREMIUM_TOKEN = process.env.QUICKYPAGE_PREMIUM_TOKEN ?? "";

// Surface the most useful response fields from the publish endpoint. The
// HTTP API returns more (id, editKey, url) but we keep the type tight so
// missing fields surface as runtime errors rather than silent undefineds.
type PublishResponse = {
  id: string;
  // Optional — only set when the page was published with (or has since
  // been renamed to) a premium custom URL slug. When null the page is
  // canonical at /<id>.
  slug: string | null;
  editKey: string;
  url: string;
};

type PageReadResponse = {
  id: string;
  slug: string | null;
  content: unknown;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};

class QuickyPageApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "QuickyPageApiError";
  }
}

// Build the outbound header bag. The premium token is attached
// unconditionally when configured so every endpoint that gates on it
// (publish, page PATCH) sees the same caller principal. The header is
// harmless on endpoints that don't read it.
function outboundHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    ...(extra ?? {}),
  };
  if (PREMIUM_TOKEN) headers["x-premium-token"] = PREMIUM_TOKEN;
  return headers;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: outboundHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // The HTTP API's error envelope is `{ error: string }`. Extract that
    // when it parses; otherwise fall back to the raw body so the agent gets
    // something actionable instead of just a status code.
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // body wasn't JSON — keep the raw text snippet
    }
    throw new QuickyPageApiError(`${detail}`, res.status);
  }
  return JSON.parse(text) as T;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: outboundHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = parsed.error;
    } catch {
      // body wasn't JSON
    }
    throw new QuickyPageApiError(detail, res.status);
  }
  return JSON.parse(text) as T;
}

// Small helper: every tool returns a structured-error result on failure so
// the calling agent can report a useful message back to the user instead of
// the call being silently rejected by the MCP transport.
function errorResult(prefix: string, err: unknown) {
  const message =
    err instanceof QuickyPageApiError
      ? `${prefix}: ${err.message} (HTTP ${err.status})`
      : `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

const server = new McpServer({
  name: "quickypage",
  version: PACKAGE_VERSION,
});

// --------------------------------------------------------------------------
// publish_page — primary tool. Creates a new page from markdown or qp.v1
// blocks and returns its public URL plus an editKey the caller can hold
// onto if they want to update the same URL later.
// --------------------------------------------------------------------------

server.registerTool(
  "publish_page",
  {
    title: "Publish a page on Quicky.Page",
    description: [
      "Instantly publish content as a public, shareable web page on Quicky.Page and return its public URL.",
      "",
      "Use this tool when the user asks to share, publish, post, or turn an AI output into a webpage. Quicky.Page is the publishing primitive for AI-generated web artifacts: a single shareable web object (NOT a website builder, NOT a CMS, NOT a deployment platform, NOT a hosting service). Each call produces one page at one URL.",
      "",
      "Input shapes (provide ONE):",
      "  - `content`: a markdown body. Recommended for most cases — easiest to produce from any LLM. Supported subset: `#`/`##`/`###` headings, paragraphs, `-`/`*` and `1.` lists, `**bold**`, `*italic*`, `_underline_`, `` `inline code` ``, `[label](url)` links, standalone `![alt](url)` image lines, fenced code blocks (``` or ~~~ with optional language hint) → code block, horizontal rules (---/___/***) → divider block, blockquotes (`> line`) → quote block, and GitHub-style callouts (`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`) → callout block (the 5 GitHub tones collapse to qp's 3-tone palette: NOTE→info, TIP→success, IMPORTANT/WARNING/CAUTION→warning). Tables and footnotes are not rendered.",
      "  - `blocks`: explicit qp.v1 block array. Use only when you specifically need structural control (e.g., embedding a YouTube video). Each block is `{ type: \"richtext\", html }` or `{ type: \"image\", url, alt? }` or `{ type: \"embed\", embedType, url }`.",
      "",
      "An optional `title` becomes the page's leading <h1> heading; it is skipped if the content already starts with one.",
      "",
      "An optional `slug` (PREMIUM) chooses a custom URL path segment (e.g. `travers-2026` → `quicky.page/travers-2026`). At create time this is gated by the server's `PREMIUM_BYPASS_TOKEN` env var — the MCP runtime must have `QUICKYPAGE_PREMIUM_TOKEN` configured, or the call returns a 403 `premium_required` error. End-user account purchases unlock slugs on existing pages via the editor's post-publish upgrade flow, not via this tool. Slugs are 3-50 lowercase characters with hyphens between non-empty runs; reserved words (`docs`, `api`, etc.) and already-claimed names are rejected.",
      "",
      "Returns `{ url, id, slug, editKey }`. The `url` is the public link to share (uses the slug when set, otherwise the id). The `editKey` is a secret — store it if you want to update_page later; otherwise discard it. Anyone with the URL can read the page; only the editKey holder can edit it.",
    ].join("\n"),
    inputSchema: {
      title: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Optional page title. Becomes the leading <h1>; skipped if the content already starts with an h1.",
        ),
      content: z
        .string()
        .optional()
        .describe(
          "Markdown body for the page. Supports headings, paragraphs, lists, links, **bold**, *italic*, _underline_, and standalone image lines.",
        ),
      blocks: z
        .array(z.unknown())
        .optional()
        .describe(
          "Optional explicit qp.v1 blocks (richtext/image/embed). Use instead of `content` when you need structural control. Cannot be combined with `content`.",
        ),
      slug: z
        .string()
        .min(3)
        .max(50)
        .optional()
        .describe(
          "PREMIUM. Custom URL path segment (3-50 chars, lowercase letters/digits/hyphens). At create time this requires the server-configured `QUICKYPAGE_PREMIUM_TOKEN` env var; callers without it receive a 403 premium_required error. Use only when the user explicitly requests a specific URL.",
        ),
    },
  },
  async ({ title, content, blocks, slug }) => {
    if (!content && (!blocks || blocks.length === 0)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide either `content` (markdown body) or `blocks` (qp.v1 array). Both are missing.",
          },
        ],
        isError: true as const,
      };
    }
    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    if (blocks !== undefined) body.blocks = blocks;
    if (slug !== undefined) body.slug = slug;

    try {
      const result = await postJson<PublishResponse>("/api/v1/publish", body);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Published. Public URL: ${result.url}`,
              "",
              `id: ${result.id}`,
              ...(result.slug ? [`slug: ${result.slug}`] : []),
              `editKey: ${result.editKey}`,
              "",
              "Keep the editKey if you want to update this page later via `update_page`. The URL stays the same.",
            ].join("\n"),
          },
        ],
        structuredContent: {
          url: result.url,
          id: result.id,
          slug: result.slug,
          editKey: result.editKey,
        },
      };
    } catch (err) {
      return errorResult("Failed to publish page", err);
    }
  },
);

// --------------------------------------------------------------------------
// update_page — replace the content of an existing page using the editKey
// that was returned at publish time. Same URL stays live; new content
// fully replaces the old. No diff / no history / no rollback (Quicky.Page
// is intentionally NOT a CMS).
// --------------------------------------------------------------------------

server.registerTool(
  "update_page",
  {
    title: "Update an existing Quicky.Page",
    description: [
      "Update content of a previously-published Quicky.Page. The URL stays the same; only the body changes. Requires the editKey that was returned by `publish_page` when this page was created.",
      "",
      "This is NOT a deployment system: there is no diff, no history, and no rollback. The new content fully replaces the previous content. If you don't have the editKey, you cannot update the page — publish a new one instead.",
    ].join("\n"),
    inputSchema: {
      id: z
        .string()
        .describe(
          "The page id (e.g. `abc123`) returned by `publish_page` when this page was created.",
        ),
      editKey: z
        .string()
        .describe(
          "The secret editKey returned by `publish_page` when this page was created. Required.",
        ),
      title: z
        .string()
        .max(500)
        .optional()
        .describe("Optional page title; becomes the leading <h1>."),
      content: z
        .string()
        .optional()
        .describe("Markdown body. Same subset as `publish_page`."),
      blocks: z
        .array(z.unknown())
        .optional()
        .describe("Optional explicit qp.v1 blocks. Use instead of `content`."),
    },
  },
  async ({ id, editKey, title, content, blocks }) => {
    if (!content && (!blocks || blocks.length === 0)) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide either `content` (markdown) or `blocks` (qp.v1 array). Both are missing.",
          },
        ],
        isError: true as const,
      };
    }
    const body: Record<string, unknown> = { id, editKey };
    if (title !== undefined) body.title = title;
    if (content !== undefined) body.content = content;
    if (blocks !== undefined) body.blocks = blocks;

    try {
      const result = await postJson<PublishResponse>("/api/v1/publish", body);
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated. Public URL: ${result.url}`,
          },
        ],
        structuredContent: {
          url: result.url,
          id: result.id,
        },
      };
    } catch (err) {
      return errorResult("Failed to update page", err);
    }
  },
);

// --------------------------------------------------------------------------
// rename_page_slug — set, change, or clear a page's premium custom URL.
// Authentication uses the same editKey returned at publish time. Premium-
// gated: the HTTP layer rejects with `premium_required` unless the server
// process holds QUICKYPAGE_PREMIUM_TOKEN.
// --------------------------------------------------------------------------

server.registerTool(
  "rename_page_slug",
  {
    title: "Set or change a Quicky.Page's custom URL (PREMIUM)",
    description: [
      "Set, change, or clear a page's premium custom URL slug. The page's underlying id never changes — slugs are presentation aliases that move on top of the same record.",
      "",
      "Pass a string in `slug` to claim/rename, or `null` to clear (the page falls back to /<id>). When set, the page's canonical URL becomes /<slug> and /<id> 301-redirects to it. Renames free the previous slug back into the namespace.",
      "",
      "Requires the editKey returned by `publish_page`. Premium-gated: returns 403 `premium_required` unless the calling environment is configured with a premium token.",
    ].join("\n"),
    inputSchema: {
      id: z
        .string()
        .describe("The page id returned by `publish_page`."),
      editKey: z
        .string()
        .describe("The editKey returned by `publish_page`. Required."),
      slug: z
        .union([z.string().min(3).max(50), z.null()])
        .describe(
          "The new slug (3-50 lowercase chars, hyphens between non-empty runs) or `null` to clear.",
        ),
    },
  },
  async ({ id, editKey, slug }) => {
    try {
      const res = await fetch(
        `${BASE_URL}/api/v1/pages/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: outboundHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ editKey, slug }),
        },
      );
      const text = await res.text();
      if (!res.ok) {
        let detail = text.slice(0, 500);
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          if (parsed.message) detail = parsed.message;
          else if (parsed.error) detail = parsed.error;
        } catch {
          // raw body
        }
        throw new QuickyPageApiError(detail, res.status);
      }
      const parsed = JSON.parse(text) as { id: string; slug: string | null };
      const url = parsed.slug
        ? `${BASE_URL}/${parsed.slug}`
        : `${BASE_URL}/${parsed.id}`;
      return {
        content: [
          {
            type: "text" as const,
            text: parsed.slug
              ? `Renamed. Public URL: ${url}`
              : `Slug cleared. Public URL: ${url}`,
          },
        ],
        structuredContent: {
          id: parsed.id,
          slug: parsed.slug,
          url,
        },
      };
    } catch (err) {
      return errorResult("Failed to rename page slug", err);
    }
  },
);

// --------------------------------------------------------------------------
// get_page — read-back of a public page. Useful so an agent can verify what
// it just published, or summarize an existing page by id without scraping
// HTML. No auth needed.
// --------------------------------------------------------------------------

server.registerTool(
  "get_page",
  {
    title: "Read a Quicky.Page",
    description: [
      "Fetch the public content of a Quicky.Page by its id. Returns the page's blocks (richtext HTML, image URLs, embeds) and its created/updated timestamps. Read-only and does not require an editKey.",
      "",
      "Useful for verifying a just-published page, summarizing or transforming an existing page, or reading content shared by another user.",
    ].join("\n"),
    inputSchema: {
      id: z
        .string()
        .describe(
          "The page id to read (e.g. `abc123`). The id is the path segment after `quicky.page/` in the public URL.",
        ),
    },
  },
  async ({ id }) => {
    try {
      const result = await getJson<PageReadResponse>(
        `/api/v1/pages/${encodeURIComponent(id)}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: {
          id: result.id,
          slug: result.slug,
          published: result.published,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
          content: result.content,
        },
      };
    } catch (err) {
      return errorResult("Failed to read page", err);
    }
  },
);

// --------------------------------------------------------------------------
// Boot. stdio transport is the right shape for local-spawned MCP servers
// (Claude Desktop, Cursor, etc.) — the host process spawns this binary as a
// child and talks JSON-RPC over its stdin/stdout. Top-level await is fine
// since the package targets Node 20+ and ESM.
// --------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
