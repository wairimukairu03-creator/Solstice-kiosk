/**
 * In-memory attendee store.
 *
 * In production this table would live in Postgres/DynamoDB etc, and the
 * transition methods below would be expressed as conditional UPDATE
 * statements (e.g. `UPDATE ... WHERE state = 'NOT_CHECKED_IN'`) so the
 * same atomicity holds across multiple kiosk-service instances. Because
 * Node processes a single request handler to completion before yielding
 * the event loop (no `await` inside the critical sections below), a plain
 * JS Map already gives us that same all-or-nothing guarantee for a single
 * process, which is enough to demonstrate the state machine correctly.
 */

const STATES = Object.freeze({
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  PRINT_PENDING: 'PRINT_PENDING',
  CHECKED_IN: 'CHECKED_IN',
  PRINT_FAILED: 'PRINT_FAILED',
});

class AttendeeStore {
  constructor(seedAttendees = []) {
    this.attendees = new Map();
    for (const a of seedAttendees) {
      this.attendees.set(a.id, {
        id: a.id,
        name: a.name,
        state: STATES.NOT_CHECKED_IN,
        currentJobId: null, // the ONE job whose callback we currently trust
        jobHistory: [], // audit trail of every job + every webhook received
      });
    }
  }

  get(id) {
    return this.attendees.get(id);
  }

  all() {
    return Array.from(this.attendees.values());
  }

  /**
   * Called when staff scan a badge. This is the sole gate that decides
   * whether a NEW print job is allowed to be published to the vendor queue.
   *
   * Returns one of:
   *   { outcome: 'ALREADY_CHECKED_IN', attendee }
   *   { outcome: 'ALREADY_PENDING',   attendee }   // duplicate scan while printing
   *   { outcome: 'PRINT_STARTED', attendee, jobId } // caller must publish jobId to queue
   *
   * No `await` happens between the state check and the state write, so
   * two rapid duplicate scans of the same attendee can never both reach
   * PRINT_STARTED.
   */
  requestCheckIn(id, jobIdFactory) {
    const attendee = this.attendees.get(id);
    if (!attendee) return { outcome: 'NOT_FOUND' };

    if (attendee.state === STATES.CHECKED_IN) {
      return { outcome: 'ALREADY_CHECKED_IN', attendee };
    }
    if (attendee.state === STATES.PRINT_PENDING) {
      // Same badge scanned again while the first print job is still in
      // flight. We do NOT publish a second job -- just report pending.
      return { outcome: 'ALREADY_PENDING', attendee };
    }

    // state is NOT_CHECKED_IN or PRINT_FAILED (retry) -> start a new job
    const jobId = jobIdFactory();
    attendee.state = STATES.PRINT_PENDING;
    attendee.currentJobId = jobId;
    attendee.jobHistory.push({ jobId, publishedAt: Date.now(), webhooks: [] });

    return { outcome: 'PRINT_STARTED', attendee, jobId };
  }

  /**
   * Called when the vendor's webhook delivers a print result.
   *
   * Must be safe against:
   *  - duplicate delivery of the same webhook (at-least-once delivery)
   *  - out-of-order delivery relative to a newer job for the same attendee
   *    (e.g. attendee had a failed job, was retried, and the STALE
   *    callback for the old job arrives after the new job was already
   *    published or already succeeded)
   */
  applyPrintResult(id, jobId, status) {
    const attendee = this.attendees.get(id);
    if (!attendee) return { outcome: 'NOT_FOUND' };

    const job = attendee.jobHistory.find((j) => j.jobId === jobId);
    if (job) job.webhooks.push({ status, receivedAt: Date.now() });

    if (!job) {
      // We never published this job (or it belongs to another attendee).
      return { outcome: 'UNKNOWN_JOB', attendee };
    }

    if (jobId !== attendee.currentJobId) {
      // This confirmation belongs to a job that has since been
      // superseded (e.g. it failed and was retried, or -- defensively --
      // arrived after the attendee already got checked in). Ignore it.
      // This is exactly what makes duplicate-scan protection hold even
      // when webhooks arrive out of order.
      return { outcome: 'STALE_JOB_IGNORED', attendee };
    }

    if (attendee.state !== STATES.PRINT_PENDING) {
      // Idempotency: a retried/duplicate webhook for the *current* job
      // arriving after we already processed it once.
      return { outcome: 'ALREADY_PROCESSED', attendee };
    }

    if (status === 'SUCCESS') {
      attendee.state = STATES.CHECKED_IN;
      return { outcome: 'CHECKED_IN', attendee };
    }

    attendee.state = STATES.PRINT_FAILED;
    return { outcome: 'PRINT_FAILED', attendee };
  }
}

module.exports = { AttendeeStore, STATES };
