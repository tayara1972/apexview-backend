require('dotenv').config();

const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // <-- add this line


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

app.use(morgan('dev'));
app.use(cors());

// Rate limiting: 60 requests per minute per IP for quotes and FX
const quotesLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // max 60 /quotes calls per minute per IP
  standardHeaders: true,
  legacyHeaders: false
});

const fxLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,               // max 60 /fx calls per minute per IP
  standardHeaders: true,
  legacyHeaders: false
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,               // max 20 search calls per minute per IP
  standardHeaders: true,
  legacyHeaders: false
});


// Attach limiters to specific routes
app.use('/quotes', quotesLimiter);
app.use('/fx', fxLimiter);
app.use('/search', searchLimiter);


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
// Stocks/ETFs: pass through (AAPL, MSFT, TSLA, etc)
// Crypto: map to BINANCE *USDT pairs (approx USD)
// This covers ~top 20 coins.
// -----------------------------------------------------------------------------
function mapToFinnhubSymbol(raw) {
  if (!raw) return null;

  const sym = raw.trim().toUpperCase();

  const cryptoMap = {
    // Bitcoin
    "BTC": "BINANCE:BTCUSDT",
    "BTC-USD": "BINANCE:BTCUSDT",

    // Ethereum
    "ETH": "BINANCE:ETHUSDT",
    "ETH-USD": "BINANCE:ETHUSDT",

    // Binance Coin
    "BNB": "BINANCE:BNBUSDT",
    "BNB-USD": "BINANCE:BNBUSDT",

    // Solana
    "SOL": "BINANCE:SOLUSDT",
    "SOL-USD": "BINANCE:SOLUSDT",

    // XRP
    "XRP": "BINANCE:XRPUSDT",
    "XRP-USD": "BINANCE:XRPUSDT",

    // Cardano
    "ADA": "BINANCE:ADAUSDT",
    "ADA-USD": "BINANCE:ADAUSDT",

    // Avalanche
    "AVAX": "BINANCE:AVAXUSDT",
    "AVAX-USD": "BINANCE:AVAXUSDT",

    // Dogecoin
    "DOGE": "BINANCE:DOGEUSDT",
    "DOGE-USD": "BINANCE:DOGEUSDT",

    // Polygon
    "MATIC": "BINANCE:MATICUSDT",
    "MATIC-USD": "BINANCE:MATICUSDT",

    // Polkadot
    "DOT": "BINANCE:DOTUSDT",
    "DOT-USD": "BINANCE:DOTUSDT",

    // Litecoin
    "LTC": "BINANCE:LTCUSDT",
    "LTC-USD": "BINANCE:LTCUSDT",

    // Chainlink
    "LINK": "BINANCE:LINKUSDT",
    "LINK-USD": "BINANCE:LINKUSDT",

    // Bitcoin Cash
    "BCH": "BINANCE:BCHUSDT",
    "BCH-USD": "BINANCE:BCHUSDT",

    // Shiba Inu
    "SHIB": "BINANCE:SHIBUSDT",
    "SHIB-USD": "BINANCE:SHIBUSDT",

    // Uniswap
    "UNI": "BINANCE:UNIUSDT",
    "UNI-USD": "BINANCE:UNIUSDT",

    // Toncoin
    "TON": "BINANCE:TONUSDT",
    "TON-USD": "BINANCE:TONUSDT",

    // Injective
    "INJ": "BINANCE:INJUSDT",
    "INJ-USD": "BINANCE:INJUSDT",

    // Optimism
    "OP": "BINANCE:OPUSDT",
    "OP-USD": "BINANCE:OPUSDT",

    // Arbitrum
    "ARB": "BINANCE:ARBUSDT",
    "ARB-USD": "BINANCE:ARBUSDT"
  };

  // 1) Explicit known mapping for top coins
  if (cryptoMap[sym]) {
    return cryptoMap[sym];
  }

  // 2) Generic pattern: ANY <TOKEN>-USD -> BINANCE:<TOKEN>USDT
  if (sym.endsWith("-USD")) {
    const base = sym.slice(0, -4); // remove "-USD"
    if (/^[A-Z0-9]{2,10}$/.test(base)) {
      return `BINANCE:${base}USDT`;
    }
  }

  // 3) Default: treat as stock/ETF, pass through (AAPL, MSFT, TSLA, etc.)
  return sym;
}


// Simple symbol validation
function isValidSymbol(sym) {
  return /^[A-Z0-9.\-]{1,20}$/.test(sym);
}

// -----------------------------------------------------------------------------
// GET /quotes?symbols=AAPL,BTC-USD,ETH-USD
// Returns:
// {
//   "source": "live",
//   "data": {
//     "AAPL":    { ... },
//     "BTC-USD": { ... },
//     "ETH-USD": { ... }
//   }
// }
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

  // Deduplicate
  requestedSymbols = Array.from(new Set(requestedSymbols));

  const MAX_SYMBOLS = 100;

  if (requestedSymbols.length === 0) {
    return res.status(400).json({ error: 'No symbols provided' });
  }

  if (requestedSymbols.length > MAX_SYMBOLS) {
    return res.status(400).json({
      error: `Too many symbols. Max allowed is ${MAX_SYMBOLS}.`
    });
  }

  // Separate valid and invalid symbols
  const validSymbols = [];
  const invalidSymbols = [];

  for (const sym of requestedSymbols) {
    if (isValidSymbol(sym)) {
      validSymbols.push(sym);
    } else {
      invalidSymbols.push(sym);
    }
  }

  // If nothing is valid, fail with a clear message
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

  const pairs = validSymbols.map(raw => ({
    raw,
    finnhub: mapToFinnhubSymbol(raw)
  }));

  const now = Date.now();
  const result = {};

  try {
    await Promise.all(
      pairs.map(async ({ raw, finnhub }) => {
        const cacheKey = `quote:${finnhub}`;
        const cached = cache.get(cacheKey);

        // Cache hit
        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
          result[raw] = { ...cached.value, symbol: raw };
          return;
        }

        // Cache miss
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
            current:       typeof q.c  === 'number' ? q.c  : null,
            high:          typeof q.h  === 'number' ? q.h  : null,
            low:           typeof q.l  === 'number' ? q.l  : null,
            open:          typeof q.o  === 'number' ? q.o  : null,
            provider: 'finnhub'
          };

          cache.set(cacheKey, { timestamp: now, value });
          result[raw] = value;
        } catch (innerErr) {
          console.error(
            'Error fetching quote for',
            raw,
            'mapped as',
            finnhub,
            innerErr.message || innerErr
          );

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
    console.error('Error in /quotes:', err);
    return res.status(500).json({
      error: 'Failed to fetch quotes',
      message: String(err)
    });
  }
});

// -----------------------------------------------------------------------------
// GET /search?query=TSLA
// Alpha Vantage SYMBOL_SEARCH via backend
// Returns a simplified list of matches for use in AddHoldingView.
// -----------------------------------------------------------------------------
app.get('/search', async (req, res) => {
  const query = (req.query.query || '').trim();

  if (!query) {
    return res.status(400).json({
      error: 'Missing query parameter'
    });
  }

  // Basic length guard to avoid abuse
  if (query.length < 1 || query.length > 20) {
    return res.status(400).json({
      error: 'Query length must be between 1 and 20 characters'
    });
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
    const matches = Array.isArray(data['bestMatches'])
      ? data['bestMatches']
      : [];

    // Map Alpha’s messy field names to a clean shape
    const results = matches.map((m) => ({
      symbol: (m['1. symbol'] || '').trim(),
      name: (m['2. name'] || '').trim(),
      region: (m['4. region'] || '').trim(),
      currency: (m['8. currency'] || '').trim()
    }))
    // Filter out any completely empty entries
    .filter(r => r.symbol.length > 0 && r.name.length > 0);

    const payload = {
      provider: 'alphavantage',
      environment: BACKEND_ENV,
      query,
      results
    };

    cache.set(cacheKey, {
      timestamp: now,
      value: payload
    });

    return res.json(payload);
  } catch (err) {
    console.error('Error in /search:', err);
    return res.status(502).json({
      error: 'Failed to search symbols via Alpha Vantage',
      message: String(err)
    });
  }
});


app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});
