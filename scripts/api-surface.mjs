#!/usr/bin/env node
/**
 * api-surface.mjs — extract a feature-scoped slice of the application's OpenAPI document.
 *
 * The app serves Swagger UI, not a plain spec file: there is no /swagger.json and no
 * /api-docs.json. The machine-readable document is embedded in the Swagger UI bootstrap
 * script as `options.swaggerDoc`, so this script fetches that script and brace-matches the
 * object out of it.
 *
 * Usage:
 *   node scripts/api-surface.mjs --match games[,catalogue] [--url <url>] [--format md|json]
 *
 * Options:
 *   --match   comma-separated match keys: an entity, an OpenAPI tag, or a route
 *             ("games", "Games", "/api/games", "GET /api/games").
 *   --url     override the Swagger UI bootstrap URL. Defaults to API_DOCS_URL from .env,
 *             then to http://localhost:5000/api-docs/swagger-ui-init.js.
 *   --format  "md" (default) emits the exact `# API Surface` block for the requirements
 *             document; "json" emits the same facts as data.
 *
 * Exit codes:
 *   0  operations matched (status "mapped" or "partial")
 *   2  usage error
 *   3  no operation matched (the spec was read successfully)
 *   4  the document could not be reached
 *   5  the document was reached but no OpenAPI object could be parsed out of it
 *
 * The whole spec is never printed. Only matched operations reach stdout.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 2;
const EXIT_NO_MATCH = 3;
const EXIT_UNREACHABLE = 4;
const EXIT_UNPARSEABLE = 5;

const DEFAULT_DOCS_URL = "http://localhost:5000/api-docs/swagger-ui-init.js";
const DEFAULT_BASE_URL = "http://localhost:9000";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- .env ------------------------------------------------------------------
// Read directly rather than through framework/configuration/config.ts: that module validates
// the whole test configuration with Joi and throws on any missing key, which would make this
// script fail for reasons that have nothing to do with the API document.
function readEnv(key, fallback) {
  try {
    const line = readFileSync(join(REPO_ROOT, ".env"), "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith(`${key}=`));
    const value = line?.slice(line.indexOf("=") + 1).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

// --- arguments -------------------------------------------------------------
function parseArgs(argv) {
  const args = { match: [], url: null, format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--match") {
      args.match = (value ?? "").split(",").map((k) => k.trim()).filter(Boolean);
      i++;
    } else if (flag === "--url") {
      args.url = value;
      i++;
    } else if (flag === "--format") {
      args.format = value;
      i++;
    } else {
      fail(EXIT_USAGE, `Unknown argument: ${flag}`);
    }
  }
  if (args.match.length === 0) fail(EXIT_USAGE, "--match is required, e.g. --match games");
  if (!["md", "json"].includes(args.format)) fail(EXIT_USAGE, `--format must be md or json, got: ${args.format}`);
  return args;
}

function fail(code, message) {
  process.stderr.write(`api-surface: ${message}\n`);
  process.exit(code);
}

// --- fetch and slice -------------------------------------------------------
async function loadSpec(url) {
  let text;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) fail(EXIT_UNREACHABLE, `${url} responded ${response.status}`);
    text = await response.text();
  } catch (error) {
    fail(EXIT_UNREACHABLE, `could not reach ${url} — ${error.message}`);
  }

  // The bootstrap script is generated JavaScript, so the document has to be sliced out by
  // brace matching. A JSON.parse of the whole file would fail, and a regex would break on the
  // first nested brace.
  const anchor = text.indexOf('"swaggerDoc"');
  if (anchor === -1) fail(EXIT_UNPARSEABLE, `${url} contains no "swaggerDoc" object — is this a Swagger UI bootstrap script?`);

  const start = text.indexOf("{", anchor);
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end === -1) fail(EXIT_UNPARSEABLE, "the swaggerDoc object is not brace-balanced");

  try {
    return JSON.parse(text.slice(start, end));
  } catch (error) {
    fail(EXIT_UNPARSEABLE, `the swaggerDoc object is not valid JSON — ${error.message}`);
  }
}

// --- matching --------------------------------------------------------------
// Precedence, strongest first. The basis that matched is reported, because it is what the
// reviewer needs in order to judge how much the match can be trusted.
const BASIS_RANK = { "exact-path": 3, tag: 2, "path-segment": 1 };

function matchBasisFor(key, { method, specPath, repoPath, tags }) {
  const k = key.toLowerCase().trim();
  const routeKey = k.replace(/^(get|post|put|patch|delete)\s+/, "");
  const methodInKey = k.match(/^(get|post|put|patch|delete)\s+/)?.[1];

  if (routeKey.startsWith("/")) {
    const pathMatches = routeKey === specPath.toLowerCase() || routeKey === repoPath.toLowerCase();
    if (pathMatches && (!methodInKey || methodInKey === method.toLowerCase())) return "exact-path";
  }
  if (tags.some((t) => t.toLowerCase() === k)) return "tag";
  if (specPath.toLowerCase().split("/").filter(Boolean).includes(k)) return "path-segment";
  return null;
}

function collectOperations(spec, keys) {
  const pathPrefix = new URL(spec.servers?.[0]?.url ?? "http://localhost/").pathname.replace(/\/$/, "");
  const globalSecurity = spec.security ?? [];
  const matched = [];

  for (const [specPath, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;

      const candidate = {
        method: method.toUpperCase(),
        specPath,
        repoPath: `${pathPrefix}${specPath}`,
        tags: op.tags ?? [],
      };
      const basis = keys
        .map((key) => matchBasisFor(key, candidate))
        .filter(Boolean)
        .sort((a, b) => BASIS_RANK[b] - BASIS_RANK[a])[0];
      if (!basis) continue;

      matched.push({
        ...candidate,
        basis,
        summary: op.summary ?? null,
        auth: describeAuth(op, globalSecurity),
        parameters: describeParameters(op),
        body: describeBody(op),
        responses: describeResponses(op),
      });
    }
  }
  return { pathPrefix, matched };
}

// An operation that states no `security` inherits the spec-wide default. That inheritance is
// reported rather than flattened: a document-wide default is a much weaker claim than an
// operation that names its own scheme, and mistaking one for the other is how a public
// endpoint acquires a 401 test that can never pass.
function describeAuth(op, globalSecurity) {
  const stated = op.security !== undefined;
  const security = stated ? op.security : globalSecurity;
  const schemes = (security ?? []).flatMap((s) => Object.keys(s)).join(", ");
  if (!schemes) return { schemes: "none", inherited: false };
  return { schemes, inherited: !stated };
}

function describeParameters(op) {
  const grouped = { query: [], path: [], header: [] };
  for (const p of op.parameters ?? []) {
    const list = grouped[p.in];
    if (!list) continue;
    const type = p.schema?.type ? ` (${p.schema.type})` : "";
    list.push(`${p.name}${type}${p.required ? " *" : ""}`);
  }
  return grouped;
}

function describeBody(op) {
  const schema = op.requestBody?.content?.["application/json"]?.schema;
  if (!schema) return null;
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const type = prop.type === "array" ? `${prop.items?.type ?? "any"}[]` : prop.format ?? prop.type ?? "any";
    const constraints = [];
    if (prop.minLength !== undefined) constraints.push(`minLength ${prop.minLength}`);
    if (prop.maxLength !== undefined) constraints.push(`maxLength ${prop.maxLength}`);
    if (prop.minimum !== undefined) constraints.push(`min ${prop.minimum}`);
    if (prop.maximum !== undefined) constraints.push(`max ${prop.maximum}`);
    const suffix = constraints.length ? `, ${constraints.join(", ")}` : "";
    return `${name} (${type}${suffix})${required.has(name) ? " *" : ""}`;
  });
  return { required: op.requestBody?.required === true, fields };
}

function describeResponses(op) {
  return Object.entries(op.responses ?? {}).map(([code, response]) => {
    const schema = response.content?.["application/json"]?.schema;
    return {
      code,
      description: response.description ?? null,
      shape: schema ? summariseSchema(schema) : null,
    };
  });
}

// One level deep on purpose. A test asserts on field names and nesting, not on the full
// recursive type graph, and a deeper dump would bury that in noise.
function summariseSchema(schema, depth = 0) {
  if (schema.$ref) return schema.$ref.split("/").pop();
  if (schema.type === "array") return `${summariseSchema(schema.items ?? {}, depth + 1)}[]`;
  if (schema.type !== "object" || !schema.properties) return schema.type ?? "any";
  if (depth >= 2) return "object";
  const fields = Object.entries(schema.properties).map(
    ([name, prop]) => `${name}: ${summariseSchema(prop, depth + 1)}`,
  );
  return `{ ${fields.join(", ")} }`;
}

// --- gaps ------------------------------------------------------------------
// Mechanical gaps only — what the document itself is silent about. A divergence between the
// spec and what the client actually sends cannot be seen from here; that is a human's
// observation and reaches the section as an endpoint hint.
function collectGaps(matched) {
  const gaps = [];
  let anyErrorShape = false;

  for (const op of matched) {
    const label = `${op.method} ${op.repoPath}`;
    if (op.responses.length === 0) {
      gaps.push(`${label}: no responses documented.`);
      continue;
    }
    for (const r of op.responses) {
      const isSuccess = r.code.startsWith("2");
      if (isSuccess && !r.shape) gaps.push(`${label}: ${r.code} has no response schema.`);
      if (!isSuccess && r.shape) anyErrorShape = true;
    }
    if (!op.responses.some((r) => /^[45]/.test(r.code))) {
      gaps.push(`${label}: no error responses documented.`);
    }
    if (["POST", "PUT", "PATCH"].includes(op.method) && !op.body) {
      gaps.push(`${label}: no request body documented.`);
    } else if (op.body && op.body.fields.length === 0) {
      gaps.push(`${label}: a request body is required but no properties are documented.`);
    }
    if (op.auth.inherited) {
      gaps.push(
        `${label}: auth is not stated on the operation — \`${op.auth.schemes}\` is inherited from the spec-wide default, ` +
          `so whether this route is public is undocumented.`,
      );
    }
  }

  if (matched.length > 0 && !anyErrorShape) {
    gaps.push("No matched operation documents an error response body, so no error message string is stated anywhere in the spec.");
  }
  return gaps;
}

// --- rendering -------------------------------------------------------------
function renderBasis(matched) {
  const counts = new Map();
  for (const op of matched) counts.set(op.basis, (counts.get(op.basis) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => BASIS_RANK[b[0]] - BASIS_RANK[a[0]])
    .map(([basis, count]) => `${basis} (${count} operation${count === 1 ? "" : "s"})`)
    .join(", ");
}

function renderMarkdown({ url, baseUrl, pathPrefix, matched, gaps, fetchedAt, keys }) {
  const lines = [
    "# API Surface",
    "",
    "_Derived from the application's OpenAPI document. Not stated in the ticket._",
    "",
    `Source: ${url}`,
    `Fetched at: ${fetchedAt}`,
    `Base URL: ${baseUrl} · Path prefix: ${pathPrefix || "(none)"}`,
    `Match keys: ${keys.join(", ")}`,
    `Match basis: ${renderBasis(matched)}`,
    "",
  ];

  for (const op of matched) {
    lines.push(`## ${op.method} ${op.repoPath}`);
    lines.push("Source: openapi");
    if (op.summary) lines.push(`Summary: ${op.summary}`);
    lines.push(
      op.auth.inherited
        ? `Auth: ${op.auth.schemes} (inherited from the spec-wide default — the operation does not state it)`
        : `Auth: ${op.auth.schemes}`,
    );
    if (op.parameters.path.length) lines.push(`Path parameters: ${op.parameters.path.join(", ")}`);
    if (op.parameters.query.length) lines.push(`Query (documented): ${op.parameters.query.join(", ")}`);
    if (op.parameters.header.length) lines.push(`Headers (documented): ${op.parameters.header.join(", ")}`);
    if (op.body) lines.push(`Body${op.body.required ? " (required)" : ""}: ${op.body.fields.join(", ") || "(no properties documented)"}`);
    lines.push(`Documented codes: ${op.responses.map((r) => r.code).join(", ") || "(none)"}`);
    for (const r of op.responses) {
      lines.push(`  ${r.code} — ${r.description ?? "(no description)"} — ${r.shape ?? "(no schema)"}`);
    }
    lines.push("");
  }

  lines.push("## Spec Gaps");
  lines.push(...(gaps.length ? gaps.map((g) => `- ${g}`) : ["- None."]));
  lines.push("");
  return lines.join("\n");
}

// --- main ------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const url = args.url ?? readEnv("API_DOCS_URL", DEFAULT_DOCS_URL);
const baseUrl = readEnv("BASE_URL", DEFAULT_BASE_URL).replace(/\/$/, "");
const fetchedAt = new Date().toISOString();

const spec = await loadSpec(url);
const { pathPrefix, matched } = collectOperations(spec, args.match);

if (matched.length === 0) {
  process.stderr.write(
    `api-surface: no operation matched ${args.match.join(", ")}. ` +
      `Available tags: ${[...new Set(Object.values(spec.paths ?? {}).flatMap((i) => Object.values(i).flatMap((o) => o.tags ?? [])))].join(", ") || "(none)"}\n`,
  );
  process.exit(EXIT_NO_MATCH);
}

matched.sort((a, b) => a.repoPath.localeCompare(b.repoPath) || a.method.localeCompare(b.method));
const gaps = collectGaps(matched);
const strongest = matched.map((op) => BASIS_RANK[op.basis]).reduce((a, b) => Math.max(a, b), 0);
const status = strongest >= BASIS_RANK.tag && gaps.length === 0 ? "mapped" : "partial";

if (args.format === "json") {
  process.stdout.write(
    JSON.stringify(
      { status, source: url, fetchedAt, baseUrl, pathPrefix, matchKeys: args.match, matchBasis: renderBasis(matched), operations: matched, specGaps: gaps },
      null,
      2,
    ) + "\n",
  );
} else {
  process.stdout.write(renderMarkdown({ url, baseUrl, pathPrefix, matched, gaps, fetchedAt, keys: args.match }));
}

process.stderr.write(`api-surface: status=${status} operations=${matched.length} basis=${renderBasis(matched)} gaps=${gaps.length}\n`);
