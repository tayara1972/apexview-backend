require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const telemetryRouter = require('./routes/telemetry');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment label for prod vs staging vs local
const BACKEND_ENV = process.env.BACKEND_ENV || process.env.NODE_ENV || 'development';

// 60 minutes caching to keep API usage tiny
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

// Finnhub for quotes (stocks + crypto)
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// Alpha Vantage key for FX (server-side net-worth conversion)
const ALPHA_FX_KEY = process.env.ALPHA_FX_KEY || process.env.ALPHA_VANTAGE_KEY;

if (!FINNHUB_API_KEY) {
  console.warn('WARNING: FINNHUB_API_KEY is not set. /quotes will fail.');
}
if (!ALPHA_FX_KEY) {
  console.warn('WARNING: ALPHA_FX_KEY (or ALPHA_VANTAGE_KEY) is not set. /fx will fail.');
}

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// -----------------------------------------------------------------------------
// Privacy safe request logging
// - No query string logging (symbols, balances, etc. must never appear in logs)
// - Logs method + path only
// -----------------------------------------------------------------------------
app.use((req, res, next) => {
  const requestId = crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex');
  res.setHeader('x-request-id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    // Only log path without query string
    const pathOnly = req.path;
    console.log(`${req.method} ${pathOnly} -> ${res.statusCode} (${Date.now() - start}ms) id=${requestId}`);
  });

  next();
});

// -----------------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------------
const quotesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const fxLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

// Attach limiters to specific routes
app.use('/quotes', quotesLimiter);
app.use('/fx', fxLimiter);
app.use('/search', searchLimiter);
app.use('/telemetry', telemetryLimiter);
app.use('/telemetry', telemetryRouter);

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ApexView quotes backend',
    environment: BACKEND_ENV,
    providers: {
      quotes: 'finnhub',
      fx: ALPHA_FX_KEY ? 'alphavantage' : 'none'
    },
    cacheTtlMinutes: CACHE_TTL_MS / 60000,
    time: new Date().toISOString()
  });
});

// -----------------------------------------------------------------------------
// Symbol mapping: app symbols -> Finnhub symbols
// -----------------------------------------------------------------------------
function mapToFinnhubSymbol(raw) {
  if (!raw) return null;

  const sym = raw.trim().toUpperCase();

  const cryptoMap = {
    "BTC": "BINANCE:BTCUSDT",
    "BTC-USD": "BINANCE:BTCUSDT",
    "ETH": "BINANCE:ETHUSDT",
    "ETH-USD": "BINANCE:ETHUSDT",
    "BNB": "BINANCE:BNBUSDT",
    "BNB-USD": "BINANCE:BNBUSDT",
    "SOL": "BINANCE:SOLUSDT",
    "SOL-USD": "BINANCE:SOLUSDT",
    "XRP": "BINANCE:XRPUSDT",
    "XRP-USD": "BINANCE:XRPUSDT",
    "ADA": "BINANCE:ADAUSDT",
    "ADA-USD": "BINANCE:ADAUSDT",
    "AVAX": "BINANCE:AVAXUSDT",
    "AVAX-USD": "BINANCE:AVAXUSDT",
    "DOGE": "BINANCE:DOGEUSDT",
    "DOGE-USD": "BINANCE:DOGEUSDT",
    "MATIC": "BINANCE:MATICUSDT",
    "MATIC-USD": "BINANCE:MATICUSDT",
    "DOT": "BINANCE:DOTUSDT",
    "DOT-USD": "BINANCE:DOTUSDT",
    "LTC": "BINANCE:LTCUSDT",
    "LTC-USD": "BINANCE:LTCUSDT",
    "LINK": "BINANCE:LINKUSDT",
    "LINK-USD": "BINANCE:LINKUSDT",
    "BCH": "BINANCE:BCHUSDT",
    "BCH-USD": "BINANCE:BCHUSDT",
    "SHIB": "BINANCE:SHIBUSDT",
    "SHIB-USD": "BINANCE:SHIBUSDT",
    "UNI": "BINANCE:UNIUSDT",
    "UNI-USD": "BINANCE:UNIUSDT",
    "TON": "BINANCE:TONUSDT",
    "TON-USD": "BINANCE:TONUSDT",
    "INJ": "BINANCE:INJUSDT",
    "INJ-USD": "BINANCE:INJUSDT",
    "OP": "BINANCE:OPUSDT",
    "OP-USD": "BINANCE:OPUSDT",
    "ARB": "BINANCE:ARBUSDT",
    "ARB-USD": "BINANCE:ARBUSDT"
  };

  if (cryptoMap[sym]) return cryptoMap[sym];

  if (sym.endsWith("-USD")) {
    const base = sym.slice(0, -4);
    if (/^[A-Z0-9]{2,10}$/.test(base)) {
      return `BINANCE:${base}USDT`;
    }
  }

  return sym;
}

function isValidSymbol(sym) {
  return /^[A-Z0-9.\-]{1,20}$/.test(sym);
}

// -----------------------------------------------------------------------------
// GET /quotes?symbols=...
// -----------------------------------------------------------------------------
app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;

  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  let requestedSymbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  requestedSymbols = Array.from(new Set(requestedSymbols));

  const MAX_SYMBOLS = 100;

  if (requestedSymbols.length === 0) {
    return res.status(400).json({ error: 'No symbols provided' });
  }

  if (requestedSymbols.length > MAX_SYMBOLS) {
    return res.status(400).json({ error: `Too many symbols. Max allowed is ${MAX_SYMBOLS}.` });
  }

  const validSymbols = [];
  const invalidSymbols = [];

  for (const sym of requestedSymbols) {
    if (isValidSymbol(sym)) validSymbols.push(sym);
    else invalidSymbols.push(sym);
  }

  if (validSymbols.length === 0) {
    return res.status(400).json({
      error: 'No valid symbols after validation',
      invalidSymbols
    });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY is not configured on the server'
    });
  }

  const pairs = validSymbols.map(raw => ({ raw, finnhub: mapToFinnhubSymbol(raw) }));

  const now = Date.now();
  const result = {};

  try {
    await Promise.all(
      pairs.map(async ({ raw, finnhub }) => {
        const cacheKey = `quote:${finnhub}`;
        const cached = cache.get(cacheKey);

        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
          result[raw] = { ...cached.value, symbol: raw };
          return;
        }

        try {
          const url =
            'https://finnhub.io/api/v1/quote?symbol=' +
            encodeURIComponent(finnhub) +
            '&token=' +
            FINNHUB_API_KEY;

          const response = await axios.get(url);

          if (response.status !== 200) {
            throw new Error('Finnhub status ' + response.status);
          }

          const q = response.data || {};

          const value = {
            symbol: raw,
            previousClose: typeof q.pc === 'number' ? q.pc : null,
            current: typeof q.c === 'number' ? q.c : null,
            high: typeof q.h === 'number' ? q.h : null,
            low: typeof q.l === 'number' ? q.l : null,
            open: typeof q.o === 'number' ? q.o : null,
            provider: 'finnhub'
          };

          cache.set(cacheKey, { timestamp: now, value });
          result[raw] = value;
        } catch (innerErr) {
          // Privacy safe: do not log symbols or mapped symbols
          console.error('Error fetching quote from provider:', innerErr.message || String(innerErr));

          result[raw] = {
            symbol: raw,
            previousClose: null,
            current: null,
            high: null,
            low: null,
            open: null,
            provider: 'finnhub'
          };
        }
      })
    );

    return res.json({
      source: 'live',
      environment: BACKEND_ENV,
      data: result,
      invalidSymbols: invalidSymbols.length > 0 ? invalidSymbols : undefined
    });
  } catch (err) {
    console.error('Error in /quotes:', err.message || String(err));
    return res.status(500).json({
      error: 'Failed to fetch quotes'
    });
  }
});

// -----------------------------------------------------------------------------
// GET /fx?from=EUR&to=USD
// -----------------------------------------------------------------------------
app.get('/fx', async (req, res) => {
  const from = (req.query.from || '').toUpperCase().trim();
  const to = (req.query.to || '').toUpperCase().trim();

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query params are required' });
  }

  if (from === to) {
    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate: 1.0,
      provider: 'alphavantage',
      lastUpdated: new Date().toISOString()
    });
  }

  if (!ALPHA_FX_KEY) {
    return res.status(500).json({
      error: 'ALPHA_FX_KEY (or ALPHA_VANTAGE_KEY) is not configured on the server'
    });
  }

  const cacheKey = `fx:${from}->${to}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.value);
  }

  const url =
    'https://www.alphavantage.co/query' +
    '?function=CURRENCY_EXCHANGE_RATE' +
    `&from_currency=${encodeURIComponent(from)}` +
    `&to_currency=${encodeURIComponent(to)}` +
    `&apikey=${ALPHA_FX_KEY}`;

  try {
    const response = await axios.get(url);

    if (response.status !== 200) {
      throw new Error('Alpha Vantage FX status ' + response.status);
    }

    const data = response.data || {};
    const payload = data['Realtime Currency Exchange Rate'];

    if (!payload || !payload['5. Exchange Rate']) {
      throw new Error('Bad FX response from Alpha Vantage');
    }

    const rate = parseFloat(payload['5. Exchange Rate']);
    if (!Number.isFinite(rate)) {
      throw new Error('FX rate is not a number');
    }

    const fxObj = {
      fromCurrency: payload['1. From_Currency Code'],
      toCurrency: payload['3. To_Currency Code'],
      rate,
      provider: 'alphavantage',
      lastUpdated: payload['6. Last Refreshed']
    };

    cache.set(cacheKey, { timestamp: now, value: fxObj });

    return res.json(fxObj);
  } catch (err) {
    console.error('Error in /fx:', err.message || String(err));
    return res.status(500).json({
      error: 'Failed to fetch FX rate'
    });
  }
});

// -----------------------------------------------------------------------------
// GET /search?query=TSLA
// -----------------------------------------------------------------------------
app.get('/search', async (req, res) => {
  const query = (req.query.query || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  if (query.length < 1 || query.length > 20) {
    return res.status(400).json({ error: 'Query length must be between 1 and 20 characters' });
  }

  if (!ALPHA_FX_KEY) {
    return res.status(500).json({
      error: 'ALPHA_FX_KEY (or ALPHA_VANTAGE_KEY) is not configured on the server'
    });
  }

  const cacheKey = `search:${query.toUpperCase()}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.value);
  }

  const url =
    'https://www.alphavantage.co/query' +
    '?function=SYMBOL_SEARCH' +
    `&keywords=${encodeURIComponent(query)}` +
    `&apikey=${ALPHA_FX_KEY}`;

  try {
    const response = await axios.get(url);

    if (response.status !== 200) {
      throw new Error('Alpha Vantage search status ' + response.status);
    }

    const data = response.data || {};
    const matches = Array.isArray(data['bestMatches']) ? data['bestMatches'] : [];

    const results = matches
      .map((m) => ({
        symbol: (m['1. symbol'] || '').trim(),
        name: (m['2. name'] || '').trim(),
        region: (m['4. region'] || '').trim(),
        currency: (m['8. currency'] || '').trim()
      }))
      .filter(r => r.symbol.length > 0 && r.name.length > 0);

    const payload = {
      provider: 'alphavantage',
      environment: BACKEND_ENV,
      query,
      results
    };

    cache.set(cacheKey, { timestamp: now, value: payload });

    return res.json(payload);
  } catch (err) {
    console.error('Error in /search:', err.message || String(err));
    return res.status(502).json({
      error: 'Failed to search symbols via Alpha Vantage'
    });
  }
});

app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});
