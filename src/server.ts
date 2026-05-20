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
const PACKAGE_VERSION = "0.2.0";

// Endpoint configuration. Defaults to production; override with env when
// pointing at a staging/preview deployment or a local Next.js dev server.
//
//   QUICKYPAGE_BASE_URL=http://localhost:3000 node dist/server.js
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

const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const ALLOWED_IMAGE_MIMES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;
type AllowedImageMime = keyof typeof ALLOWED_IMAGE_MIMES;

const allowedImageMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const richTextBlockSchema = z.object({
  type: z.literal("richtext"),
  html: z.string().describe("Sanitized rich text HTML: p, br, h1-h3, strong, em, u, a, ul, ol, li."),
});

const imageBlockSchema = z.object({
  type: z.literal("image"),
  url: z.string().describe("Image URL. For attached or generated images, call upload_image first and use its returned publicUrl."),
  alt: z.string().max(500).optional(),
});

const embedBlockSchema = z.object({
  type: z.literal("embed"),
  embedType: z.enum(["youtube", "twitter", "figma", "codepen", "iframe_sandbox"]),
  url: z.string(),
  title: z.string().max(500).optional(),
});

const htmlBlockSchema = z.object({
  type: z.literal("html"),
  html: z.string(),
  safetyMode: z.literal("strict_sanitized").optional(),
});

const calloutBlockSchema = z.object({
  type: z.literal("callout"),
  tone: z.enum(["info", "warning", "success"]),
  html: z.string().describe("Structured-cell HTML: p, br, strong, em, u, a, ul, ol, li."),
});

const quoteBlockSchema = z.object({
  type: z.literal("quote"),
  html: z.string().describe("Structured-cell HTML: p, br, strong, em, u, a, ul, ol, li."),
  attribution: z.string().max(500).optional(),
});

const dividerBlockSchema = z.object({
  type: z.literal("divider"),
});

const timelineBlockSchema = z.object({
  type: z.literal("timeline"),
  items: z.array(z.object({ label: z.string(), body: z.string() })).min(1).max(12),
});

const comparisonBlockSchema = z.object({
  type: z.literal("comparison"),
  left: z.string(),
  right: z.string(),
  leftLabel: z.string().max(200).optional(),
  rightLabel: z.string().max(200).optional(),
});

const codeBlockSchema = z.object({
  type: z.literal("code"),
  code: z.string(),
  language: z
    .enum([
      "plaintext",
      "ts",
      "tsx",
      "js",
      "jsx",
      "json",
      "html",
      "css",
      "py",
      "rb",
      "go",
      "rust",
      "java",
      "c",
      "cpp",
      "csharp",
      "swift",
      "kotlin",
      "php",
      "sh",
      "sql",
      "yaml",
      "toml",
      "xml",
      "md",
      "diff",
    ])
    .optional(),
  filename: z.string().max(200).optional(),
});

const buttonBlockSchema = z.object({
  type: z.literal("button"),
  url: z.string(),
  label: z.string().max(200),
  description: z.string().max(300).optional(),
  variant: z.enum(["filled", "outline", "soft"]),
  shape: z.enum(["rounded", "pill", "square"]),
  accent: z.enum(["theme", "slate", "blue", "green", "amber", "red", "purple", "pink"]),
  icon: z.string().max(8).optional(),
});

const blockSchema = z.discriminatedUnion("type", [
  richTextBlockSchema,
  imageBlockSchema,
  embedBlockSchema,
  htmlBlockSchema,
  calloutBlockSchema,
  quoteBlockSchema,
  dividerBlockSchema,
  timelineBlockSchema,
  comparisonBlockSchema,
  codeBlockSchema,
  buttonBlockSchema,
]);

type ImageBlock = z.infer<typeof imageBlockSchema>;

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

type PublishResult = PublishResponse & {
  editUrl: string;
};

type PageReadResponse = {
  id: string;
  slug: string | null;
  content: unknown;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};

type PresignedUpload = {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  headers: Record<string, string>;
  method: "PUT";
  expiresInSec: number;
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

function absoluteUrl(url: string): string {
  return new URL(url, `${BASE_URL}/`).toString();
}

function editUrlFor(id: string, editKey: string): string {
  return `${BASE_URL}/?id=${encodeURIComponent(id)}#edit=${encodeURIComponent(
    editKey,
  )}`;
}

function withEditUrl(result: PublishResponse): PublishResult {
  return {
    ...result,
    editUrl: editUrlFor(result.id, result.editKey),
  };
}

function sniffImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function decodeBase64Image(input: string): Uint8Array {
  const trimmed = input.trim();
  const base64 = trimmed.startsWith("data:")
    ? (trimmed.match(/^data:[^;]+;base64,(.+)$/s)?.[1] ?? "")
    : trimmed;
  if (!base64) throw new Error("Image data is empty.");
  if (!/^[A-Za-z0-9+/=\s_-]+$/.test(base64)) {
    throw new Error("Image data must be base64 encoded.");
  }
  const normalized = base64.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) throw new Error("Image data decoded to an empty file.");
  return bytes;
}

async function uploadImageBytes(input: {
  bytes: Uint8Array;
  mimeType: AllowedImageMime;
}): Promise<PresignedUpload & { publicUrl: string }> {
  const presigned = await postJson<PresignedUpload>("/api/upload", {
    mime: input.mimeType,
    size: input.bytes.byteLength,
  });

  const uploadRes = await fetch(absoluteUrl(presigned.uploadUrl), {
    method: presigned.method,
    headers: presigned.headers,
    body: new Blob([input.bytes], { type: input.mimeType }),
  });

  if (!uploadRes.ok) {
    const detail = (await uploadRes.text().catch(() => "")).slice(0, 500);
    throw new QuickyPageApiError(
      detail || `Upload PUT failed with ${uploadRes.status}`,
      uploadRes.status,
    );
  }

  return { ...presigned, publicUrl: absoluteUrl(presigned.publicUrl) };
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
// upload_image — asset ingestion for attached or generated images. Claude
// passes base64 bytes; Quicky.Page returns a public URL suitable for an image
// block. The bytes go through the same signed-upload path as the web editor.
// --------------------------------------------------------------------------

server.registerTool(
  "upload_image",
  {
    title: "Upload an image for a Quicky.Page",
    description: [
      "Upload an attached or AI-generated image to Quicky.Page image hosting and return a public URL plus a ready-to-use qp.v1 image block.",
      "",
      "Use this before `publish_page` or `update_page` whenever the user wants an attached image or generated image included on the page. Do not put raw base64 image data in page markdown or blocks. Upload the image first, then include the returned `block` in the page's `blocks` array.",
      "",
      "Supports PNG, JPEG, WEBP, and GIF up to 7 MB. SVG is intentionally not supported.",
    ].join("\n"),
    inputSchema: {
      data: z
        .string()
        .describe("Base64-encoded image bytes. A data:image/...;base64,... URL is also accepted."),
      mimeType: allowedImageMimeSchema.describe(
        "Declared image MIME type. Must match the image bytes.",
      ),
      alt: z
        .string()
        .max(500)
        .optional()
        .describe("Optional alt text to include in the returned image block."),
    },
  },
  async ({ data, mimeType, alt }) => {
    try {
      const bytes = decodeBase64Image(data);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image is too large. Max ${Math.floor(
                MAX_UPLOAD_BYTES / 1024 / 1024,
              )} MB.`,
            },
          ],
          isError: true as const,
        };
      }

      const sniffed = sniffImageMime(bytes);
      if (sniffed !== mimeType) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Image bytes do not match mimeType (declared ${mimeType}, detected ${
                sniffed ?? "unknown"
              }).`,
            },
          ],
          isError: true as const,
        };
      }

      const uploaded = await uploadImageBytes({ bytes, mimeType });
      const block: ImageBlock = { type: "image", url: uploaded.publicUrl };
      if (alt?.trim()) block.alt = alt.trim();

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Uploaded image: ${uploaded.publicUrl}`,
              "",
              "Use the returned `block` in `publish_page` or `update_page`.",
            ].join("\n"),
          },
        ],
        structuredContent: {
          publicUrl: uploaded.publicUrl,
          key: uploaded.key,
          block,
        },
      };
    } catch (err) {
      return errorResult("Failed to upload image", err);
    }
  },
);

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
      "  - `blocks`: explicit qp.v1 block array. Use when you need structural control, images, embeds, code, callouts, timelines, comparisons, buttons, or sanitized HTML. For attached or generated images, call `upload_image` first and include the returned image block.",
      "",
      "An optional `title` becomes the page's leading <h1> heading; it is skipped if the content already starts with one.",
      "",
      "An optional `slug` (PREMIUM) chooses a custom URL path segment (e.g. `travers-2026` → `quicky.page/travers-2026`). At create time this is gated by the MCP runtime's `QUICKYPAGE_PREMIUM_TOKEN`; without it, the call returns a 403 `premium_required` error. End-user account purchases unlock slugs on existing pages via the editor's post-publish upgrade flow, not via this tool. Slugs are 3-50 lowercase characters with hyphens between non-empty runs; reserved words (`docs`, `api`, etc.) and already-claimed names are rejected.",
      "",
      "Returns `{ url, editUrl, id, slug, editKey }`. The `url` is the public link to share (uses the slug when set, otherwise the id). The `editUrl` opens the editor in one click and contains the secret edit credential in the URL fragment. Treat both `editUrl` and `editKey` as secrets.",
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
          "Markdown body for the page. Cannot be combined with `blocks`. For attached/generated images, call `upload_image` first and use a standalone ![alt](url) line.",
        ),
      blocks: z
        .array(blockSchema)
        .min(1)
        .optional()
        .describe(
          "Explicit qp.v1 blocks. Cannot be combined with `content`. Use the `block` returned by `upload_image` for attached/generated images.",
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
    if (content && blocks) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide either `content` (markdown body) or `blocks` (qp.v1 array), not both.",
          },
        ],
        isError: true as const,
      };
    }
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
      const result = withEditUrl(
        await postJson<PublishResponse>("/api/v1/publish", body),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Published. Public URL: ${result.url}`,
              "",
              `id: ${result.id}`,
              ...(result.slug ? [`slug: ${result.slug}`] : []),
              `editUrl: ${result.editUrl}`,
              `editKey: ${result.editKey}`,
              "",
              "Share the public URL with readers. Give the editUrl only to someone who should edit the page; it contains the secret edit credential.",
            ].join("\n"),
          },
        ],
        structuredContent: {
          url: result.url,
          id: result.id,
          slug: result.slug,
          editUrl: result.editUrl,
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
      "Provide exactly one content shape: `content` markdown or explicit qp.v1 `blocks`. For attached or generated images, call `upload_image` first and include its returned image block in `blocks`.",
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
        .describe("Markdown body. Same subset as `publish_page`. Cannot be combined with `blocks`."),
      blocks: z
        .array(blockSchema)
        .min(1)
        .optional()
        .describe("Explicit qp.v1 blocks. Cannot be combined with `content`. Use the `block` returned by `upload_image` for attached/generated images."),
    },
  },
  async ({ id, editKey, title, content, blocks }) => {
    if (content && blocks) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Provide either `content` (markdown) or `blocks` (qp.v1 array), not both.",
          },
        ],
        isError: true as const,
      };
    }
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
      const result = withEditUrl(
        await postJson<PublishResponse>("/api/v1/publish", body),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Updated. Public URL: ${result.url}`,
              `Edit URL: ${result.editUrl}`,
            ].join("\n"),
          },
        ],
        structuredContent: {
          url: result.url,
          id: result.id,
          slug: result.slug,
          editUrl: result.editUrl,
          editKey: result.editKey,
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
      const editUrl = editUrlFor(parsed.id, editKey);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              parsed.slug ? `Renamed. Public URL: ${url}` : `Slug cleared. Public URL: ${url}`,
              `Edit URL: ${editUrl}`,
            ].join("\n"),
          },
        ],
        structuredContent: {
          id: parsed.id,
          slug: parsed.slug,
          url,
          editUrl,
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
