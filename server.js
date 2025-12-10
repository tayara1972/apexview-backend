require('dotenv').config();

const express = require('express');
const axios = require('axios');
const morgan = require('morgan');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 60 minutes caching to keep API usage tiny
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

if (!FINNHUB_API_KEY) {
  console.warn('WARNING: FINNHUB_API_KEY is not set. Quotes/FX will fail.');
}

app.use(morgan('dev'));
app.use(cors());

// Simple health check / info
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ApexView quotes backend',
    provider: 'finnhub',
    cacheTtlMinutes: CACHE_TTL_MS / 60000
  });
});

/**
 * Map your app symbols to Finnhub symbols.
 * - Stocks/ETFs: pass through (AAPL, MSFT, TSLA, etc)
 * - Crypto: map to BINANCE *USDT pairs (approx USD)
 *
 * We cover ~top 20 major coins.
 */
function mapToFinnhubSymbol(raw) {
  const s = raw.toUpperCase().trim();

  // Helper for common pattern
  const binance = suffix => `BINANCE:${suffix}`;

  switch (s) {
    // Bitcoin
    case 'BTC':
    case 'BTC-USD':
      return binance('BTCUSDT');

    // Ethereum
    case 'ETH':
    case 'ETH-USD':
      return binance('ETHUSDT');

    // Binance Coin
    case 'BNB':
    case 'BNB-USD':
      return binance('BNBUSDT');

    // Solana
    case 'SOL':
    case 'SOL-USD':
      return binance('SOLUSDT');

    // XRP
    case 'XRP':
    case 'XRP-USD':
      return binance('XRPUSDT');

    // Cardano
    case 'ADA':
    case 'ADA-USD':
      return binance('ADAUSDT');

    // Avalanche
    case 'AVAX':
    case 'AVAX-USD':
      return binance('AVAXUSDT');

    // Dogecoin
    case 'DOGE':
    case 'DOGE-USD':
      return binance('DOGEUSDT');

    // Polygon
    case 'MATIC':
    case 'MATIC-USD':
      return binance('MATICUSDT');

    // Polkadot
    case 'DOT':
    case 'DOT-USD':
      return binance('DOTUSDT');

    // Litecoin
    case 'LTC':
    case 'LTC-USD':
      return binance('LTCUSDT');

    // Chainlink
    case 'LINK':
    case 'LINK-USD':
      return binance('LINKUSDT');

    // Bitcoin Cash
    case 'BCH':
    case 'BCH-USD':
      return binance('BCHUSDT');

    // Shiba Inu
    case 'SHIB':
    case 'SHIB-USD':
      return binance('SHIBUSDT');

    // Uniswap
    case 'UNI':
    case 'UNI-USD':
      return binance('UNIUSDT');

    // Toncoin
    case 'TON':
    case 'TON-USD':
      return binance('TONUSDT');

    // Render/Injective/other majors – examples
    case 'INJ':
    case 'INJ-USD':
      return binance('INJUSDT');

    case 'OP':
    case 'OP-USD':
      return binance('OPUSDT');

    case 'ARB':
    case 'ARB-USD':
      return binance('ARBUSDT');

    // If not one of the mapped cryptos, treat as stock/ETF ticker
    default:
      return s;
  }
}

/**
 * Simple symbol validation:
 * - Uppercase letters, digits, dash, dot
 * - Max 20 chars
 */
function isValidSymbol(sym) {
  return /^[A-Z0-9.\-]{1,20}$/.test(sym);
}

/**
 * GET /quotes?symbols=AAPL,BTC-USD,ETH-USD
 *
 * Returns:
 *  {
 *    "source": "live",
 *    "data": {
 *      "AAPL":    { ... },
 *      "BTC-USD": { ... },
 *      "ETH-USD": { ... }
 *    }
 *  }
 */
app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;

  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  // Parse, clean, uppercase
  let rawSymbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  // Deduplicate
  rawSymbols = Array.from(new Set(rawSymbols));

  // Hard cap to avoid abuse
  const MAX_SYMBOLS = 100;
  if (rawSymbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' });
  }
  if (rawSymbols.length > MAX_SYMBOLS) {
    return res.status(400).json({
      error: `Too many symbols. Max allowed is ${MAX_SYMBOLS}.`
    });
  }

  // Validate symbol format
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

  // Pair original symbol with its Finnhub symbol
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
          result[raw] = {
            ...cached.value,
            symbol: raw
          };
          return;
        }

        // Cache miss, call Finnhub
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

          cache.set(cacheKey, {
            timestamp: now,
            value
          });

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

/**
 * GET /fx?from=EUR&to=USD
 *
 * Uses Finnhub forex rates with base=USD.
 * Response:
 * {
 *   "from": "EUR",
 *   "to": "USD",
 *   "rate": 1.0834,
 *   "provider": "finnhub"
 * }
 */
app.get('/fx', async (req, res) => {
  let { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      error: 'from and to query params are required'
    });
  }

  from = String(from).toUpperCase().trim();
  to   = String(to).toUpperCase().trim();

  if (from === to) {
    return res.json({
      from,
      to,
      rate: 1.0,
      provider: 'finnhub'
    });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY is not configured on the server'
    });
  }

  const BASE = 'USD';

  try {
    const cacheKey = `fx:${BASE}`;
    const now = Date.now();

    let baseRates = null;

    const cached = cache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      baseRates = cached.value;
    } else {
      const url =
        'https://finnhub.io/api/v1/forex/rates?base=' +
        encodeURIComponent(BASE) +
        '&token=' +
        FINNHUB_API_KEY;

      const response = await axios.get(url);

      if (response.status !== 200) {
        throw new Error('Finnhub FX status ' + response.status);
      }

      const data = response.data || {};
      const quotes = data.quote || {};

      baseRates = quotes;
      cache.set(cacheKey, {
        timestamp: now,
        value: baseRates
      });
    }

    // baseRates: e.g. { "EUR": 0.91, "GBP": 0.78, ... } vs USD
    const rateFromBase = (code) => {
      if (code === BASE) return 1.0;
      const v = baseRates[code];
      return typeof v === 'number' ? v : null;
    };

    const rFrom = rateFromBase(from);
    const rTo   = rateFromBase(to);

    if (rFrom == null || rTo == null) {
      return res.status(400).json({
        error: 'Unsupported currency code',
        details: { from, to }
      });
    }

    // Cross rate: from -> to, both quoted vs BASE
    // Example: BASE=USD, from=EUR (0.91), to=GBP (0.78)
    // 1 EUR = (GBP/USD) / (EUR/USD) = 0.78 / 0.91
    const rate = rTo / rFrom;

    return res.json({
      from,
      to,
      rate,
      provider: 'finnhub'
    });
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
