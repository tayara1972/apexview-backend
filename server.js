require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const telemetryRouter = require('./routes/telemetry');

const app = express();
const PORT = process.env.PORT || 3000;

const BACKEND_ENV = process.env.BACKEND_ENV || process.env.NODE_ENV || 'development';

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const ALPHA_FX_KEY = process.env.ALPHA_FX_KEY || process.env.ALPHA_VANTAGE_KEY;

if (!FINNHUB_API_KEY) {
  console.warn('WARNING: FINNHUB_API_KEY is not set.');
}

if (!ALPHA_FX_KEY) {
  console.warn('WARNING: ALPHA_FX_KEY is not set.');
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
      fx: ALPHA_FX_KEY ? 'alphavantage' : 'none'
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

let q;

try {
  const response = await axios.get(url);
  q = response.data || {};
} catch (err) {
  console.error(`Finnhub failed for ${raw}:`, err.message);

  // Fallback to Alpha Vantage if available
  if (ALPHA_FX_KEY) {
    try {
      const avUrl =
        'https://www.alphavantage.co/query?function=GLOBAL_QUOTE' +
        `&symbol=${encodeURIComponent(raw)}` +
        `&apikey=${ALPHA_FX_KEY}`;

      const avResp = await axios.get(avUrl);
      const avData = avResp.data?.['Global Quote'] || {};

      q = {
        pc: parseFloat(avData['08. previous close']),
        c: parseFloat(avData['05. price']),
        h: parseFloat(avData['03. high']),
        l: parseFloat(avData['04. low']),
        o: parseFloat(avData['02. open'])
      };

      console.log(`Fallback used for ${raw}`);
    } catch (fallbackErr) {
      console.error(`Fallback failed for ${raw}:`, fallbackErr.message);
      return;
    }
  } else {
    return;
  }
}
console.log("Using provider for", raw, ":", q?.pc ? "AlphaVantage" : "Finnhub");

    
    const matches = Array.isArray(data.result) ? data.result : [];

const results = matches
  .filter(m => m.symbol && m.description)
  .filter(m => !m.symbol.includes('.')) // removes AAPL.TO, AAPL.MX, etc
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
    console.error('Error in /search:', err.message);
    return res.status(502).json({
      error: 'Failed to search via Finnhub'
    });
  }
});

// ----------------------------------------------------------------------------
// GET /fx  (Alpha Vantage)
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
      provider: 'alphavantage'
    });
  }

  if (!ALPHA_FX_KEY) {
    return res.status(500).json({
      error: 'ALPHA_FX_KEY not configured'
    });
  }

  try {
    const url =
      'https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE' +
      `&from_currency=${from}` +
      `&to_currency=${to}` +
      `&apikey=${ALPHA_FX_KEY}`;

    const response = await axios.get(url);
    const data = response.data || {};
    const payload = data['Realtime Currency Exchange Rate'];

    if (!payload || !payload['5. Exchange Rate']) {
      throw new Error('Invalid FX response');
    }

    const rate = parseFloat(payload['5. Exchange Rate']);

    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate,
      provider: 'alphavantage'
    });

  } catch (err) {
    console.error('Error in /fx:', err.message);
    return res.status(502).json({ error: 'Failed to fetch FX rate' });
  }
});

app.listen(PORT, () => {
  console.log(`ApexView backend listening on port ${PORT}`);
});
