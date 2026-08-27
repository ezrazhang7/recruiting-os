# Recruiting OS

Evidence-first recruiting intelligence for clubs whose deadlines and recruiting events are fragmented across Gmail, GroupMe, Instagram, LinkedIn, websites, link-in-bio hubs, application forms, Heel Life, and screenshots.

## What is in this codebase

This repository contains the real TypeScript implementation **and a compiled `dist/` build**.

- Immutable `source_items` and extracted `claims`.
- Resolver that derives canonical applications/events using source authority, recency, open/closed state, and stale-deadline handling.
- GroupMe OAuth URL, group listing, incremental message sync with `after_id`, and image attachments.
- Gmail watch/push helpers, history cursor sync, MIME parsing, and recruiting-flyer attachment ingestion.
- Instagram Professional-account Business Discovery ingestion, including carousel images and bio website discovery.
- LinkedIn organization vanity-name lookup + authorized organization-post ingestion + image hydration. This intentionally does **not** scrape logged-in LinkedIn pages.
- Web/link-in-bio crawler with bounded recursion and SSRF protections; application links are followed so forms/pages can contribute their own state.
- Screenshot ingestion for Stories, personal Instagram accounts, flyers, and unsupported sources.
- Optional multimodal OpenAI Responses extraction with a deterministic fallback extractor for local/offline tests.
- SQLite runtime store plus a production-oriented Postgres/Supabase schema.
- Minimal HTTP API/dashboard.
- 180 Degrees Consulting @ UNC regression scenario for stale website + closed form + newer social-source behavior.

## Quick start

Node 22.5+ is required because the local store uses Node's built-in SQLite module.

The ZIP already contains compiled JS, so the fastest path is:

```bash
cp .env.example .env
npm start
# http://localhost:4318
# JSON: http://localhost:4318/api/dashboard
```

To edit/rebuild TypeScript:

```bash
npm install
npm test
npm run dev
```

Run the 180DC regression demo:

```bash
npm run demo:180dc
```

## Environment variables

```dotenv
PORT=4318
DATABASE_PATH=./data/recruiting-os.sqlite
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
GROUPME_CLIENT_ID=
GROUPME_ACCESS_TOKEN=
GMAIL_ACCESS_TOKEN=
GMAIL_USER_ID=me
META_ACCESS_TOKEN=
META_API_VERSION=v24.0
META_IG_USER_ID=
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_VERSION=202608
```

The connector classes accept injected `fetch` implementations, so OAuth/token management can live in a separate auth layer without coupling credentials to the domain code.

## Data model

The important design choice is that a deadline is **not** the primitive. Evidence is.

```text
organization
   ├── source_item: Gmail message
   ├── source_item: GroupMe message
   ├── source_item: Instagram post/image
   ├── source_item: LinkedIn org post
   ├── source_item: website/link hub
   └── source_item: application form
             ↓
           claims
             ↓
          resolver
             ↓
 canonical application/event state
```

An old website can therefore remain preserved as evidence without being mistaken for the current recruiting cycle.

## API

Current minimal routes:

- `GET /api/dashboard`
- `GET /api/organizations/:id`
- `POST /api/organizations`
- `POST /api/ingest/url`
- `POST /api/ingest/screenshot`

Example organization:

```json
{
  "id": "180dc-unc",
  "name": "180 Degrees Consulting at UNC",
  "school": "University of North Carolina at Chapel Hill",
  "heelLifeUrl": "https://heellife.unc.edu/...",
  "websiteUrl": "https://unc180dc.wixsite.com/home/join-us",
  "instagramHandle": "unc180dc",
  "linkedinUrl": "https://www.linkedin.com/company/180-degrees-consulting-unc/"
}
```

Example screenshot ingestion:

```json
{
  "organizationId": "180dc-unc",
  "base64": "...",
  "mimeType": "image/png",
  "note": "Instagram Story screenshot",
  "publishedAt": "2026-08-27T12:00:00-04:00"
}
```

## Tests

The repository currently has **26 passing tests** covering URL classification, deadline/event disambiguation, stale/open/closed resolution, GroupMe cursors/images, Gmail push/MIME/attachments, Instagram carousels, LinkedIn org lookup/images, web crawling, and the 180DC stale-source scenario.

## Production notes

This is an MVP core, not a finished hosted SaaS. Before multi-user production deployment, add encrypted credential storage, real OAuth callback/session handling, background queues, webhook/PubSub workers, per-user tenancy/RLS, observability, rate-limit backoff, and a proper front-end. The connector/domain boundaries here are intended to survive that migration.
