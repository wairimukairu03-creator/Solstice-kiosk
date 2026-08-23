const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { AttendeeStore } = require('./store');
const { startVendorSimulator } = require('./vendorQueueSim');

function createApp({ seedAttendees, failureRate = 0, port }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const store = new AttendeeStore(seedAttendees);

  // --- Server-Sent Events, so the kiosk UI updates the instant the
  // webhook confirms a print, without polling. ---
  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  }

  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // Vendor queue: publishing here is a fire-and-forget, non-blocking call.
  // The kiosk service does NOT wait for a print result before responding.
  //
  // BASE_URL should be set to the service's own public URL once deployed
  // (e.g. https://your-app.onrender.com). Falls back to localhost for
  // local development.
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const vendorQueue = startVendorSimulator({
    webhookUrl: `${baseUrl}/webhook/print-callback`,
    failureRate,
  });

  app.get('/attendees', (req, res) => {
    res.json(store.all());
  });

  app.get('/status/:id', (req, res) => {
    const attendee = store.get(req.params.id);
    if (!attendee) return res.status(404).json({ error: 'not_found' });
    res.json(attendee);
  });

  // Staff scans a QR code -> this fires.
  app.post('/scan', (req, res) => {
    const { attendeeId } = req.body;

    const result = store.requestCheckIn(attendeeId, () => uuidv4());

    if (result.outcome === 'NOT_FOUND') {
      return res.status(404).json({ error: 'attendee_not_found' });
    }

    if (result.outcome === 'ALREADY_CHECKED_IN') {
      return res.status(200).json({
        status: 'ALREADY_CHECKED_IN',
        message: `${result.attendee.name} is already checked in. No badge reprinted.`,
        attendee: result.attendee,
      });
    }

    if (result.outcome === 'ALREADY_PENDING') {
      return res.status(200).json({
        status: 'PENDING',
        message: `${result.attendee.name}'s badge is already printing.`,
        attendee: result.attendee,
      });
    }

    // PRINT_STARTED: publish the job to the vendor's queue and return
    // immediately with a PENDING status. The UI must NOT show
    // "Checked In" yet.
    vendorQueue.publish({
      jobId: result.jobId,
      attendeeId: result.attendee.id,
      attendeeName: result.attendee.name,
    });

    broadcast('status_changed', result.attendee);

    return res.status(202).json({
      status: 'PENDING',
      message: `Print job queued for ${result.attendee.name}.`,
      attendee: result.attendee,
    });
  });

  // Vendor calls this once a print job actually completes (success or
  // failure). Delivery may be delayed, retried, or arrive out of order
  // relative to other jobs for the same attendee.
  app.post('/webhook/print-callback', (req, res) => {
    const { jobId, attendeeId, status } = req.body;

    if (!jobId || !attendeeId || !['SUCCESS', 'FAILED'].includes(status)) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const result = store.applyPrintResult(attendeeId, jobId, status);

    if (result.outcome !== 'NOT_FOUND') {
      broadcast('status_changed', result.attendee);
    }

    // Always 200 on anything we recognize as "handled" (including
    // STALE_JOB_IGNORED / ALREADY_PROCESSED) so the vendor doesn't retry
    // forever. Idempotent by design.
    switch (result.outcome) {
      case 'NOT_FOUND':
        return res.status(404).json({ error: 'attendee_not_found' });
      case 'UNKNOWN_JOB':
        return res.status(200).json({ outcome: result.outcome });
      default:
        return res.status(200).json({ outcome: result.outcome, attendee: result.attendee });
    }
  });

  return { app, store };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  const seedAttendees = [
    { id: 'A1', name: 'Amina Otieno' },
    { id: 'A2', name: 'Brian Mwangi' },
    { id: 'A3', name: 'Cynthia Wafula' },
  ];
  const { app } = createApp({ seedAttendees, failureRate: 0, port });
  app.listen(port, () => {
    console.log(`Kiosk service listening on http://localhost:${port}`);
  });
}

module.exports = { createApp };
