require('dotenv').config();

const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const cors = require('cors');

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

  let rawSymbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  // Deduplicate
  rawSymbols = Array.from(new Set(rawSymbols));

  const MAX_SYMBOLS = 100;
  if (rawSymbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' });
  }
  if (rawSymbols.length > MAX_SYMBOLS) {
    return res.status(400).json({
      error: `Too many symbols. Max allowed is ${MAX_SYMBOLS}.`
    });
  }

  const invalidSymbols = rawSymbols.filter(s => !isValidSymbol(s));
  if (invalidSymbols.length > 0) {
    return res.status(400).json({
      error: 'Invalid symbol format',
      invalidSymbols
    });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY is not configured on the server'
    });
  }

  const pairs = rawSymbols.map(raw => ({
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
      data: result
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
// GET /fx?from=EUR&to=USD
// Uses Alpha Vantage CURRENCY_EXCHANGE_RATE, with caching.
// JSON shape is friendly for your iOS FX decoding.
// -----------------------------------------------------------------------------
app.get('/fx', async (req, res) => {
  const from = (req.query.from || '').toUpperCase().trim();
  const to   = (req.query.to   || '').toUpperCase().trim();

  if (!from || !to) {
    return res.status(400).json({
      error: 'from and to query params are required'
    });
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
  const cached = cache.get(cacheKey);
  const now = Date.now();

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
      toCurrency:   payload['3. To_Currency Code'],
      rate,
      provider: 'alphavantage',
      lastUpdated: payload['6. Last Refreshed']
    };

    cache.set(cacheKey, {
      timestamp: now,
      value: fxObj
    });

    return res.json(fxObj);
  } catch (err) {
    console.error('Error in /fx:', err);
    return res.status(500).json({
      error: 'Failed to fetch FX rate',
      message: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});
