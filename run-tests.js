/**
 * End-to-end scenario test. Boots the real Express app on a local port,
 * drives it purely over HTTP (like a real kiosk client + real vendor
 * webhook would), and asserts the required behavior:
 *
 *  1. Three attendees can be checked in.
 *  2. A duplicate scan of an already-checked-in attendee does NOT print
 *     a second badge (no second job published / no state change).
 *  3. A duplicate scan WHILE a print is in flight also does not publish
 *     a second job.
 *  4. Webhook confirmations that arrive out of order / duplicated for a
 *     stale job are ignored and never falsely check someone in or undo
 *     a completed check-in.
 */

const { createApp } = require('../src/server');
const { AttendeeStore } = require('../src/store');

const PORT = 4123;
const BASE = `http://localhost:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function scan(attendeeId) {
  const res = await fetch(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attendeeId }),
  });
  return { status: res.status, body: await res.json() };
}

async function status(attendeeId) {
  const res = await fetch(`${BASE}/status/${attendeeId}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilCheckedIn(attendeeId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await status(attendeeId);
    if (s.state === 'CHECKED_IN' || s.state === 'PRINT_FAILED') return s;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${attendeeId} to leave PRINT_PENDING`);
}

async function main() {
  const seedAttendees = [
    { id: 'A1', name: 'Amina Otieno' },
    { id: 'A2', name: 'Brian Mwangi' },
    { id: 'A3', name: 'Cynthia Wafula' },
  ];
  const { app, store } = createApp({ seedAttendees, failureRate: 0, port: PORT });
  const server = app.listen(PORT);
  console.log(`Test server up on :${PORT}\n`);

  try {
    console.log('Scenario 1: Amina scans -> immediately PENDING, never instantly CHECKED_IN');
    const r1 = await scan('A1');
    assert(r1.status === 202, 'HTTP 202 (accepted, not yet complete) returned for first scan');
    assert(r1.body.status === 'PENDING', 'response status is PENDING, not CHECKED_IN');
    const s1Immediate = await status('A1');
    assert(s1Immediate.state === 'PRINT_PENDING', 'attendee state is PRINT_PENDING right after scan');

    console.log('\nScenario 2: Duplicate scan WHILE print is in flight');
    const r1dup = await scan('A1');
    assert(r1dup.body.status === 'PENDING', 'second scan while pending returns PENDING, not a new print');
    const jobsForA1 = store.get('A1').jobHistory.length;
    assert(jobsForA1 === 1, 'only ONE print job was ever created for A1 despite two scans');

    console.log('\nScenario 3: wait for real webhook confirmation to arrive asynchronously');
    const s1Final = await waitUntilCheckedIn('A1');
    assert(s1Final.state === 'CHECKED_IN', 'A1 transitions to CHECKED_IN only after webhook confirms');

    console.log('\nScenario 4: Duplicate scan AFTER already checked in (classic case)');
    const r1dupAfter = await scan('A1');
    assert(r1dupAfter.body.status === 'ALREADY_CHECKED_IN', 'post-completion duplicate scan reports ALREADY_CHECKED_IN');
    assert(store.get('A1').jobHistory.length === 1, 'still only one job ever -> no second badge printed');

    console.log('\nScenario 5: two more distinct attendees check in normally');
    await scan('A2');
    await scan('A3');
    const s2 = await waitUntilCheckedIn('A2');
    const s3 = await waitUntilCheckedIn('A3');
    assert(s2.state === 'CHECKED_IN', 'A2 checked in');
    assert(s3.state === 'CHECKED_IN', 'A3 checked in');

    console.log('\nScenario 6: out-of-order / duplicate webhook delivery is ignored');
    // Manually replay A1's ORIGINAL (already-consumed) job's webhook a
    // second time, simulating the vendor's at-least-once delivery
    // retrying a callback long after it was already applied.
    const staleJobId = store.get('A1').jobHistory[0].jobId;
    const replay = await fetch(`${BASE}/webhook/print-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: staleJobId, attendeeId: 'A1', status: 'SUCCESS' }),
    });
    const replayBody = await replay.json();
    assert(replayBody.outcome === 'ALREADY_PROCESSED', 'replayed webhook for a completed job is a no-op (ALREADY_PROCESSED)');
    assert((await status('A1')).state === 'CHECKED_IN', 'A1 remains CHECKED_IN, unaffected by replay');

    console.log('\nScenario 7: stale job id (superseded by a retry) never overrides current state');
    // Simulate: an attendee whose FIRST print job failed, got retried,
    // and then the FAILED job's late webhook finally arrives after the
    // retry already succeeded.
    const testStore = new AttendeeStore([{ id: 'Z1', name: 'Zawadi Kimani' }]);
    const firstJob = testStore.requestCheckIn('Z1', () => 'job-1');
    testStore.applyPrintResult('Z1', firstJob.jobId, 'FAILED');
    assert(testStore.get('Z1').state === 'PRINT_FAILED', 'first job failed as expected');

    const retryJob = testStore.requestCheckIn('Z1', () => 'job-2');
    testStore.applyPrintResult('Z1', retryJob.jobId, 'SUCCESS');
    assert(testStore.get('Z1').state === 'CHECKED_IN', 'retry job succeeded, attendee checked in');

    // Late, out-of-order arrival of job-1's failure callback (or even a
    // mistaken SUCCESS) must not touch state anymore.
    const lateResult = testStore.applyPrintResult('Z1', firstJob.jobId, 'SUCCESS');
    assert(lateResult.outcome === 'STALE_JOB_IGNORED', 'late callback for superseded job-1 is ignored');
    assert(testStore.get('Z1').state === 'CHECKED_IN', 'attendee state unaffected by the stale, out-of-order webhook');

    console.log('\nALL SCENARIOS PASSED ✅');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
