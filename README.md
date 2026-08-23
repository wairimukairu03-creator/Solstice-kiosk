# Solstice Events Co. — Async Check-In Kiosk

Rebuilt to match the badge-printer vendor's new asynchronous model:
publish a print request to the vendor's message queue, return
immediately with a **PENDING** state, and only mark an attendee
**CHECKED_IN** once the vendor's webhook confirms the print succeeded.

## Run it

    npm install
    node src/server.js
    # open http://localhost:3000

## Run the test scenarios (3 attendees incl. duplicate scan + out-of-order webhooks)

    node test/run-tests.js

## Architecture

- `src/store.js` — the state machine. `NOT_CHECKED_IN → PRINT_PENDING → CHECKED_IN`
  (or `PRINT_FAILED`, which can be retried). This is the ONLY place that
  decides whether a new print job is allowed to be published, and the
  ONLY place that decides whether a webhook is allowed to change state.
- `src/vendorQueueSim.js` — stands in for the vendor's real message queue
  + webhook delivery, so the demo is runnable end-to-end. Swap `publish()`
  for a real SQS/RabbitMQ send in production; the webhook receiver
  (`/webhook/print-callback`) doesn't change.
- `src/server.js` — Express API: `POST /scan`, `POST /webhook/print-callback`,
  `GET /status/:id`, `GET /events` (SSE for live UI updates).
- `public/index.html` — kiosk UI; shows PENDING until the webhook fires.

## How duplicate-scan protection holds under async, out-of-order confirmations

Each attendee record tracks a single `currentJobId` — the one job whose
webhook we currently trust.

1. **Scan while `NOT_CHECKED_IN` or `PRINT_FAILED`** → a new `jobId` is
   minted, state flips to `PRINT_PENDING`, and that job is published to
   the queue. This state flip happens synchronously, with no `await` in
   between the check and the write, so two scans arriving back-to-back
   can't both pass the gate.
2. **Scan while `PRINT_PENDING`** → no new job is published; caller just
   gets told it's already pending.
3. **Scan while `CHECKED_IN`** → no new job is published; caller is told
   it's already checked in. No second badge, ever.
4. **Webhook arrives** → it's only applied if its `jobId` matches the
   attendee's `currentJobId` **and** the attendee is still
   `PRINT_PENDING`. Any other webhook — a duplicate delivery, or a late
   callback for a job that was since superseded by a retry — is
   recognized as `STALE_JOB_IGNORED` or `ALREADY_PROCESSED` and dropped
   as a no-op. This is what keeps things correct even when the vendor's
   queue delivers callbacks late, out of order, or more than once.

See `test/run-tests.js` for all 7 scenarios exercised against the real
HTTP API, including a manually-replayed stale webhook and a
failed→retried→late-callback race.
