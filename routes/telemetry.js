// routes/telemetry.js
const express = require('express');
const router = express.Router();

const ALLOWED_ENDPOINTS = new Set(['/quotes', '/fx', '/search']);
const ALLOWED_ERROR_TYPES = new Set(['httpError', 'decoding', 'network', 'timeout', 'badURL', 'unknown']);

function isUUID(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}


function isISODate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function isSafeString(s, maxLen) {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen;
}

function containsPIIish(s) {
  if (typeof s !== 'string') return false;
  const email = /@/;
  const phone = /(\+?\d[\d\s\-()]{7,}\d)/;
  return email.test(s) || phone.test(s);
}

router.post('/', (req, res) => {
  const body = req.body;

  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const { reportId, createdAt, backendEnvironment, appVersion, iosVersion, deviceModel, events } = body;

  if (!isUUID(reportId)) return res.status(400).json({ ok: false, error: 'invalid_reportId' });
  if (!isISODate(createdAt)) return res.status(400).json({ ok: false, error: 'invalid_createdAt' });

  if (!isSafeString(backendEnvironment, 32) || containsPIIish(backendEnvironment)) {
    return res.status(400).json({ ok: false, error: 'invalid_backendEnvironment' });
  }
  if (!isSafeString(appVersion, 32) || containsPIIish(appVersion)) {
    return res.status(400).json({ ok: false, error: 'invalid_appVersion' });
  }
  if (!isSafeString(iosVersion, 32) || containsPIIish(iosVersion)) {
    return res.status(400).json({ ok: false, error: 'invalid_iosVersion' });
  }
  if (!isSafeString(deviceModel, 64) || containsPIIish(deviceModel)) {
    return res.status(400).json({ ok: false, error: 'invalid_deviceModel' });
  }

  if (!Array.isArray(events)) return res.status(400).json({ ok: false, error: 'invalid_events' });

  if (events.length > 300) {
    return res.status(413).json({ ok: false, error: 'too_many_events' });
  }

  for (const e of events) {
    if (typeof e !== 'object' || e === null) return res.status(400).json({ ok: false, error: 'invalid_event' });

    const { timestamp, endpoint, httpStatus, errorType, requestId } = e;

    if (!isISODate(timestamp)) return res.status(400).json({ ok: false, error: 'invalid_event_timestamp' });
    if (!ALLOWED_ENDPOINTS.has(endpoint)) return res.status(400).json({ ok: false, error: 'invalid_event_endpoint' });

    if (!(httpStatus === null || httpStatus === undefined || (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599))) {
      return res.status(400).json({ ok: false, error: 'invalid_event_httpStatus' });
    }

    if (!ALLOWED_ERROR_TYPES.has(errorType)) {
      return res.status(400).json({ ok: false, error: 'invalid_event_errorType' });
    }

    if (!isUUID(requestId)) return res.status(400).json({ ok: false, error: 'invalid_event_requestId' });

  // PII-ish rejection:
// - check endpoint + errorType only (fixed allowlists already make this safe)
// - do NOT run PII detection on requestId (UUID) or timestamps
if (containsPIIish(endpoint) || containsPIIish(errorType)) {
  return res.status(400).json({ ok: false, error: 'pii_detected' });
}

  }

  console.log('[telemetry] report', reportId, 'events', events.length, 'env', backendEnvironment);

  return res.status(200).json({
    ok: true,
    reportId,
    received: events.length
  });
});

// IMPORTANT: this must be module.exports = router (not export default)
module.exports = router;
