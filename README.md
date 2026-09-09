# hubspot-dotloop-connector

A two-way sync service between **HubSpot** (Contacts, Deals) and **Dotloop**
(Contacts, Loops, Loop Participants), driven by webhooks on both sides with
a periodic reconciliation poll as a safety net.

```
HubSpot Contact  <----->  Dotloop Contact / Loop Participant
HubSpot Deal     <----->  Dotloop Loop (summary + detail fields)
```

## One-click deploy (Render)

The fastest way to get this actually connected: deploy it as a [Render
Blueprint](https://render.com/docs/blueprint-spec) (`render.yaml` in this
repo). One click provisions the web service *and* a managed Postgres
database together, assigns a real public HTTPS URL, and applies the DB
schema automatically on first boot — no server, tunnel, or manual `DATABASE_URL`
wiring required.

1. Push this repo to your own GitHub (or GitLab) account — Render deploys
   from a repo it can see, so this step can't be skipped:
   ```bash
   git init && git add -A && git commit -m "Initial commit"
   git remote add origin https://github.com/<you>/hubspot-dotloop-connector.git
   git push -u origin main
   ```
2. Go to [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints)
   → **New Blueprint Instance** → pick that repo. Render reads `render.yaml`
   and shows you the web service + database it's about to create.
3. It'll prompt for the secrets marked `sync: false` in `render.yaml` —
   paste in `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_APP_ID`,
   `DOTLOOP_CLIENT_ID`, `DOTLOOP_CLIENT_SECRET` (see "Register apps on both
   platforms" below for where to get these), and a `DOTLOOP_WEBHOOK_SIGNING_SECRET`
   / `HUBSPOT_WEBHOOK_SIGNING_SECRET` you generate yourself (`openssl rand -hex 32`).
   `DOTLOOP_DEFAULT_PROFILE_ID` can be left blank — it's auto-resolved.
4. Deploy. Once it's live at `https://<your-service>.onrender.com`, visit
   `/auth/hubspot/start` and `/auth/dotloop/start` on that URL to connect
   both accounts, then run the two `register:*` scripts locally (pointed at
   that same `DATABASE_URL`, or via Render's shell) to wire up webhooks.

No Render account, or want it somewhere else entirely (your own VPS, Fly.io,
Railway, etc.)? Skip to "Setup" below and follow the manual steps — the
`Dockerfile` and `docker-compose.yml` work anywhere Docker runs.

## How it works

- **OAuth**: `GET /auth/hubspot/start` and `GET /auth/dotloop/start` kick off
  each platform's authorization-code flow; tokens are stored (with refresh)
  in Postgres via Prisma.
- **Inbound webhooks**: `POST /webhooks/hubspot` and `POST /webhooks/dotloop`
  verify the request signature, then hand the affected record off to the
  sync engine (`src/sync`).
- **Sync engine**: for each entity pair, looks up (or creates) a row in
  `ObjectMapping` linking the HubSpot id to the Dotloop id, converts the
  source record into a small canonical shape, and pushes it to the other
  side — unless the content hash matches what was last synced, in which
  case it's a no-op (this is what stops the two systems from ping-ponging
  updates back and forth forever).
- **Reconciliation poller** (`src/sync/reconcile.ts`): every
  `RECONCILE_INTERVAL_MINUTES` (default 15), re-scans anything modified
  since the last pass on both sides and re-runs it through the same sync
  functions. Catches anything a missed/failed webhook delivery would
  otherwise drop.

## Project layout

```
src/
  config.ts              env var loading
  auth/                  OAuth flows + token storage/refresh
  clients/                HubSpot & Dotloop API wrappers (typed, auto-refresh)
  webhooks/               inbound webhook receivers + signature verification
  sync/                   field mapping + bidirectional sync logic + poller
  routes/                 Express routers (auth, health)
  utils/                  logging, crypto (signatures, content hashing)
scripts/
  registerHubspotWebhooks.ts     one-time: point HubSpot at this server
  registerDotloopSubscriptions.ts one-time: point Dotloop at this server
prisma/schema.prisma      OAuthToken / ObjectMapping / SyncLog / ReconcileState
```

## Setup

### 1. Register apps on both platforms

**HubSpot** — create an app at [developers.hubspot.com](https://developers.hubspot.com/):
- Auth tab: note the **Client ID**, **Client Secret**, and **App ID**; add
  redirect URL `https://your-domain/auth/hubspot/callback`.
- Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`,
  `crm.objects.deals.read`, `crm.objects.deals.write`, `webhooks` (adjust to
  taste; must match `HUBSPOT_SCOPES` below).

**Dotloop** — register an OAuth app per
[dotloop.github.io/public-api](https://dotloop.github.io/public-api/)
(reach out to your Dotloop partner/API contact — app registration isn't
fully self-serve). Note the **Client ID**/**Client Secret**, and set the
redirect URI to `https://your-domain/auth/dotloop/callback`.

Push webhook *subscriptions* on Dotloop are called out in their docs as an
"initial release, available by request" feature — ask your Dotloop contact
to enable it for your account. Until it's on, the reconciliation poller
keeps things in sync on a delay, so the connector is fully usable either
way.

### 2. Configure

```bash
cp .env.example .env
# fill in HUBSPOT_*, DOTLOOP_*, PUBLIC_BASE_URL, DATABASE_URL
```

`PUBLIC_BASE_URL` must be the HTTPS URL this server is reachable at — both
platforms call back into it. (Skip this on Render — see "One-click deploy"
above; `RENDER_EXTERNAL_URL` covers it automatically.)

### 3. Install, migrate, run

```bash
npm install
npm run dev     # migrates the Postgres schema automatically, then http://localhost:3000
```

The schema (`migrations/001_init.sql`, applied via plain `pg` — no ORM,
no native binary to fetch) runs on every boot and is idempotent, so there's
no separate migrate step to remember. Run it standalone with `npm run migrate`
if you just want the tables created without starting the server.

Or with Docker (spins up Postgres too):

```bash
docker compose up --build
```

### 4. Connect both accounts

Visit (in a browser, while the server is reachable at `PUBLIC_BASE_URL`):

- `${PUBLIC_BASE_URL}/auth/hubspot/start`
- `${PUBLIC_BASE_URL}/auth/dotloop/start`

Each completes an OAuth consent flow and stores the resulting tokens.

### 5. Register webhooks

```bash
npm run register:hubspot-webhooks
npm run register:dotloop-subscriptions
```

These are idempotent — safe to re-run any time (e.g. after adding event
types).

### 6. Verify

- `GET /health` — checks the DB connection.
- Change a contact/deal in HubSpot or a contact/loop in Dotloop and watch
  the server logs; check the `SyncLog` table for a `SUCCESS` row.

## Things you'll likely need to customize

- **`src/sync/dealLoopMapping.ts` — `STAGE_TO_STATUS`**: HubSpot deal
  stages are custom per-portal internal IDs, and Dotloop loop `status` is a
  small fixed enum scoped to a `transactionType`. There's no universal
  mapping between them — fill in this table with your actual pipeline
  stage IDs (Settings → Objects → Deals → Pipelines in HubSpot) and the
  Dotloop statuses you want them to map to. `DEFAULT_TRANSACTION_TYPE`
  controls what kind of loop gets created for a new deal (defaults to
  `PURCHASE_OFFER`; use `LISTING_FOR_SALE` etc. if this connector is
  fronting listing-side deals instead).
- **Field lists**: `HUBSPOT_CONTACT_PROPERTIES` / the deal property list
  and the `CanonicalContact` / `CanonicalDeal` shapes in `src/sync/*Mapping.ts`
  are a reasonable starting set (name, email, phone, address; deal name,
  amount, stage, close date) — add more properties/fields on both sides as
  needed, they follow the same pattern.
- **Multi-account**: this scaffold assumes exactly one connected HubSpot
  portal and one connected Dotloop profile (`tokenStore.getSoleToken`
  throws if it finds zero or more than one). If you need to run this
  against multiple portals/profiles, thread an `accountKey` through the
  client factories and route webhooks/mappings by it.
- **Loop participants**: `LOOP_PARTICIPANT_*` webhook events currently just
  re-sync the parent loop's summary/detail; if you want participants
  synced as individual HubSpot contacts associated with the deal (rather
  than only the primary Dotloop "contact" record), extend
  `dealLoopSync.ts` to call `dotloop.listParticipants` and map each one
  through the existing contact sync + `associateDealWithContact`.

## Security notes

- Both webhook receivers verify the request signature before doing
  anything else (HubSpot: HMAC-SHA256 over `method+uri+body+timestamp`,
  base64; Dotloop: HMAC-SHA1 over the raw body, hex) and reject requests
  older than 5 minutes.
- OAuth `state` is a random nonce checked on callback (in-memory — swap for
  a shared store if you run more than one instance).
- Nothing here logs full access/refresh tokens; keep it that way if you
  extend the logging.

## Known limitations / honest gaps

- Dotloop's public docs don't expose a server-side "find contact by email"
  filter, so `findContactByEmail` pages through `/contact` client-side.
  Fine at typical brokerage contact-list sizes; cache an email→id index if
  yours is very large.
- The `event` field shapes documented for Dotloop webhook payloads
  (`LOOP_CREATED`, `CONTACT_UPDATED`, etc.) were taken from Dotloop's public
  docs at the time this was written — double-check against a live payload
  the first time you wire this up, in case they've since changed.
- This was built and run (not just typechecked) in a sandboxed environment
  against a real local Postgres: schema migrations, `/health`, the
  `/auth/*/start` OAuth redirects (correct URLs, scopes, and `state` nonce),
  and the webhook signature guard (rejects unsigned requests) all verified
  working. What that sandbox couldn't reach were the actual HubSpot/Dotloop
  APIs (no app credentials available there — those exist only in your
  accounts) or an outbound tunnel service to receive real inbound webhooks
  (blocked by the sandbox's network policy). Each API call was written
  directly against the documented request/response shapes, but budget time
  for a first real run against sandbox/test accounts on both sides — via
  the Render one-click deploy above or your own host — before trusting it
  with production data.
