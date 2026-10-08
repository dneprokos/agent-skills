# site-map.md — schema

The contract between the site mapper (writes it) and the explorer (reads it). Both follow this file;
neither invents a column, a status value or a section.

Path: `docs/exploratory/<slug>/site-map.md`.

## Layout

```markdown
# Site map — <base_url>

- base_url: <origin + optional base path, exactly as given>
- mode: <requested mode> (used: <mode actually used>)
- source: <repo path | repo URL | —>
- date: <YYYY-MM-DD>
- pages: <n>
- code-only routes: <n> (<ids or —>)
- live-only routes: <n> (<ids or —>)
- truncated: <yes — reason | no>

## Pages

| id | url (normalized) | title | source | requires | links_to | forms | notes |
|---|---|---|---|---|---|---|---|
| P01 | http://localhost:3000/ | Home | both | none | P02, P03 | search(q) | |

## External links

| url | found_on |
|---|---|
| https://example.org/ | P01 |

## Finding candidates

| id | page | note |
|---|---|---|
| C01 | P07 | Route `/legacy` is declared in code but the live site answers 404. |
```

`## External links` and `## Finding candidates` always exist. An empty one holds a single row of `—` cells.

## Columns

| Column | Rule |
|---|---|
| `id` | `P01`, `P02`, … in discovery order. Never reused, never renumbered. |
| `url (normalized)` | Full URL as `scripts/pw.mjs` normalizes it: fragment dropped (a `#/route` hash route is kept), query sorted, no trailing slash except the root. A code route with a dynamic segment keeps its pattern: `http://localhost:3000/products/:id`. |
| `title` | The `<title>` seen live. `—` for a page never opened live. |
| `source` | `live` — found by crawling only. `code` — found in the router config only. `both` — found by both. |
| `requires` | `none`, `auth` (needs a logged-in user) or `admin` (needs an administrator). `auth` when a live visit redirects to a login page or answers 401. `admin` when the URL, the router guard or the role check names an admin role, or the gated page sits under an admin area. When unsure between the two, write `auth` and say why in `notes`. |
| `links_to` | Ids of pages this page links to in the same origin, comma separated, `—` if none. Only ids that exist in the table. |
| `forms` | One entry per form: `name(field,field)`, e.g. `login(user,password); search(q)`. `—` if none. |
| `notes` | Short facts the explorer needs: `redirects to P04`, `status 404`, `pattern, not navigable`, `login page`, `variants skipped: ?page=2..9`. |

## Rules

- **Same origin only.** Every row in `## Pages` is on the base origin. Everything else goes to `## External links`.
- **One row per normalized URL.** `/about`, `/about/` and `/about#team` are one row.
- **A redirect is not a page.** If `/admin` lands on `/login`, the row for `/login` exists once; `/admin` gets its own row only when the live visit proves it is a distinct route (code, or a link to it) — its `requires` is `auth` or `admin` and its `notes` say `redirects to <id>`.
- **Code-only and live-only.** A route in `code` but not reachable live is a `code-only route` (header) and a `## Finding candidates` row, unless it is gated (`requires` ≠ `none`) and redirects to a login — that is a working guard, not a defect. A route found only by crawling is a `live-only route`.
- **Dynamic routes** (`/products/:id`, Next.js `[id]`) are listed once, with `source: code` and the note `pattern, not navigable`. They are never visited.
- **Query variants.** At most three URLs per path that differ only by query string are listed; the rest are counted in `notes` (`variants skipped: …`).
- **Credentials never appear** in this file, in any column, in any form.
- **Truncation.** If the page cap or the deadline stopped the crawl, `truncated: yes — <reason>` and the unvisited discovered URLs are still listed with `notes: discovered, not opened`.
