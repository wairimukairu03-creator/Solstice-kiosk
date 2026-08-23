/**
 * Stand-in for the badge-printer vendor's real infrastructure.
 *
 * In production `publish()` below is replaced by whatever the vendor
 * actually offers (e.g. an AWS SQS `SendMessage` call, a RabbitMQ
 * `channel.publish`, or a vendor SDK call) and the webhook delivery is
 * done BY THE VENDOR, hitting our `/webhook/print-callback` endpoint --
 * we don't control its timing, ordering, or delivery guarantees.
 *
 * This simulator exists purely so the scenario is runnable end-to-end:
 * it "prints" the badge after a random delay and then calls our own
 * webhook, optionally with artificial delay/reordering/duplication so we
 * can prove the store handles those cases.
 */

function startVendorSimulator({ webhookUrl, failureRate = 0 }) {
  const pending = [];

  function publish(job) {
    // job: { jobId, attendeeId, attendeeName }
    const printTimeMs = 300 + Math.random() * 900;
    const willFail = Math.random() < failureRate;

    const timer = setTimeout(async () => {
      const status = willFail ? 'FAILED' : 'SUCCESS';
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: job.jobId,
            attendeeId: job.attendeeId,
            status,
          }),
        });
      } catch (err) {
        console.error('[vendor-sim] webhook delivery failed:', err.message);
      }
    }, printTimeMs);

    pending.push(timer);
  }

  return { publish };
}

module.exports = { startVendorSimulator };
