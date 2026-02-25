require('dotenv').config();

const express = require('express');

const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const telemetryRouter = require('./routes/telemetry');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const BACKEND_ENV = process.env.BACKEND_ENV || process.env.NODE_ENV || 'development';

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;


if (!FINNHUB_API_KEY) {
  console.warn('WARNING: FINNHUB_API_KEY is not set.');
}

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// ----------------------------------------------------------------------------
// Privacy-safe logging
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  const requestId =
    crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex');

  res.setHeader('x-request-id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms) id=${requestId}`
    );
  });

  next();
});

// ----------------------------------------------------------------------------
// Rate limiting
// ----------------------------------------------------------------------------
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/quotes', limiter);
app.use('/fx', limiter);
app.use('/search', limiter);
app.use('/telemetry', limiter);
app.use('/telemetry', telemetryRouter);

// ----------------------------------------------------------------------------
// Lightweight health check (for wake-up + monitoring)
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: BACKEND_ENV
  });
});

// ----------------------------------------------------------------------------
// Root route (detailed info)
// ----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ApexView backend',
    environment: BACKEND_ENV,
    providers: {
      quotes: 'finnhub',
      search: 'finnhub',
      fx: 'finnhub'
    },
    cacheTtlMinutes: CACHE_TTL_MS / 60000,
    time: new Date().toISOString()
  });
});

// ----------------------------------------------------------------------------
// Symbol mapping for crypto
// ----------------------------------------------------------------------------
function mapToFinnhubSymbol(raw) {
  if (!raw) return null;

  const sym = raw.trim().toUpperCase();

  const cryptoMap = {
    BTC: 'BINANCE:BTCUSDT',
    ETH: 'BINANCE:ETHUSDT',
    SOL: 'BINANCE:SOLUSDT',
    XRP: 'BINANCE:XRPUSDT'
  };

  if (cryptoMap[sym]) return cryptoMap[sym];

  if (sym.endsWith('-USD')) {
    const base = sym.slice(0, -4);
    return `BINANCE:${base}USDT`;
  }

  return sym;
}

// ----------------------------------------------------------------------------
// GET /quotes
// ----------------------------------------------------------------------------
app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;

  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  const symbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY not configured'
    });
  }

  const now = Date.now();
  const result = {};

  try {
await Promise.all(
  symbols.map(async raw => {
    try {
      const mapped = mapToFinnhubSymbol(raw);
      const cacheKey = `quote:${mapped}`;
      const cached = cache.get(cacheKey);

      if (cached && now - cached.timestamp < CACHE_TTL_MS) {
        result[raw] = cached.value;
        return;
      }

      const url =
        'https://finnhub.io/api/v1/quote?symbol=' +
        encodeURIComponent(mapped) +
        '&token=' +
        FINNHUB_API_KEY;

      const response = await axios.get(url, { timeout: 8000 });
      const q = response.data || {};

      const value = {
        symbol: raw,
        previousClose: q.pc ?? null,
        current: q.c ?? null,
        high: q.h ?? null,
        low: q.l ?? null,
        open: q.o ?? null,
        provider: 'finnhub'
      };

      cache.set(cacheKey, { timestamp: now, value });
      result[raw] = value;

    } catch (err) {
      console.error('Quote fetch failed for', raw, err.message);
      // Do NOT throw
      // Just skip this symbol
    }
  })
);

 return res.json({
  source: 'finnhub',
  environment: BACKEND_ENV,
  version: 1,
  data: result
});
    
  } catch (err) {
    console.error('Error in /quotes:', err.message);
    return res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// ----------------------------------------------------------------------------
// GET /search  (Finnhub)
// ----------------------------------------------------------------------------
app.get('/search', async (req, res) => {
  const query = (req.query.query || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY not configured'
    });
  }

  const cacheKey = `search:${query.toUpperCase()}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.value);
  }

  try {
    const url =
      'https://finnhub.io/api/v1/search?q=' +
      encodeURIComponent(query) +
      '&token=' +
      FINNHUB_API_KEY;

    const response = await axios.get(url, { timeout: 8000 });
    const data = response.data || {};

    const matches = Array.isArray(data.result) ? data.result : [];

    const results = matches
      .filter(m => m.symbol && m.description)
      .filter(m => !m.symbol.includes('.'))
      .map(m => ({
        symbol: m.symbol,
        name: m.description,
        region: '',
        currency: ''
      }))
      .slice(0, 10);

    const payload = {
      provider: 'finnhub',
      environment: BACKEND_ENV,
      query,
      results
    };

    cache.set(cacheKey, { timestamp: now, value: payload });

    return res.json(payload);

  } catch (err) {
    console.error("Search status:", err.response?.status);
    console.error("Search data:", err.response?.data);
    console.error("Search message:", err.message);

    return res.status(502).json({
      error: "Failed to search via Finnhub",
      detail: err.response?.data || err.message
    });
  }
});

// ----------------------------------------------------------------------------
// GET /fx  (Finnhub)
// ----------------------------------------------------------------------------
app.get('/fx', async (req, res) => {
  const from = (req.query.from || '').toUpperCase().trim();
  const to = (req.query.to || '').toUpperCase().trim();

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to required' });
  }

  if (from === to) {
    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      provider: 'finnhub'
    });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY not configured'
    });
  }

  const cacheKey = `fx:${from}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  // Cache base currency rates for 1 hour
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    const rate = cached.value[to];
    if (!rate) {
      return res.status(404).json({ error: 'Currency not supported' });
    }

    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate,
      provider: 'finnhub'
    });
  }

  try {
    const url =
      'https://finnhub.io/api/v1/forex/rates?base=' +
      encodeURIComponent(from) +
      '&token=' +
      FINNHUB_API_KEY;

    const response = await axios.get(url, { timeout: 8000 });
    const data = response.data || {};
    const quotes = data.quote || {};

    if (!quotes[to]) {
      throw new Error('Currency not found in Finnhub response');
    }

    cache.set(cacheKey, {
      timestamp: now,
      value: quotes
    });

    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate: quotes[to],
      provider: 'finnhub'
    });

  } catch (err) {
    console.error("FX status:", err.response?.status);
    console.error("FX data:", err.response?.data);
    console.error("FX message:", err.message);

    return res.status(502).json({
      error: "Failed to fetch FX rate",
      detail: err.response?.data || err.message
    });
  }
});

