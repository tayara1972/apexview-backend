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

// Health check
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
 * - Crypto: map to BINANCE USDT pairs (approx USD)
 */
function mapToFinnhubSymbol(raw) {
  const s = raw.toUpperCase().trim();
  const binance = suffix => `BINANCE:${suffix}`;

  switch (s) {
    case 'BTC':
    case 'BTC-USD':
      return binance('BTCUSDT');

    case 'ETH':
    case 'ETH-USD':
      return binance('ETHUSDT');

    case 'BNB':
    case 'BNB-USD':
      return binance('BNBUSDT');

    case 'SOL':
    case 'SOL-USD':
      return binance('SOLUSDT');

    case 'XRP':
    case 'XRP-USD':
      return binance('XRPUSDT');

    case 'ADA':
    case 'ADA-USD':
      return binance('ADAUSDT');

    case 'AVAX':
    case 'AVAX-USD':
      return binance('AVAXUSDT');

    case 'DOGE':
    case 'DOGE-USD':
      return binance('DOGEUSDT');

    case 'MATIC':
    case 'MATIC-USD':
      return binance('MATICUSDT');

    case 'DOT':
    case 'DOT-USD':
      return binance('DOTUSDT');

    case 'LTC':
    case 'LTC-USD':
      return binance('LTCUSDT');

    case 'LINK':
    case 'LINK-USD':
      return binance('LINKUSDT');

    case 'BCH':
    case 'BCH-USD':
      return binance('BCHUSDT');

    case 'SHIB':
    case 'SHIB-USD':
      return binance('SHIBUSDT');

    case 'UNI':
    case 'UNI-USD':
      return binance('UNIUSDT');

    case 'TON':
    case 'TON-USD':
      return binance('TONUSDT');

    case 'INJ':
    case 'INJ-USD':
      return binance('INJUSDT');

    case 'OP':
    case 'OP-USD':
      return binance('OPUSDT');

    case 'ARB':
    case 'ARB-USD':
      return binance('ARBUSDT');

    default:
      // Treat as stock/ETF
      return s;
  }
}

/**
 * Simple symbol validation.
 */
function isValidSymbol(sym) {
  return /^[A-Z0-9.\-]{1,20}$/.test(sym);
}

/**
 * GET /quotes?symbols=AAPL,BTC-USD,ETH-USD
 */
app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;

  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  let rawSymbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  rawSymbols = Array.from(new Set(rawSymbols)); // dedupe

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

/**
 * GET /fx?from=EUR&to=USD
 * Uses Finnhub forex rates with base = USD.
 */
a// Alpha Vantage key for FX (keep this near the top of the file)
const ALPHA_FX_KEY = process.env.ALPHA_FX_KEY || process.env.ALPHA_VANTAGE_KEY;

/**
 * GET /fx?from=EUR&to=USD
 *
 * Uses Alpha Vantage CURRENCY_EXCHANGE_RATE
 * and caches results for 60 minutes.
 */
app.get('/fx', async (req, res) => {
  let { from, to } = req.query;

  from = String(from || '').toUpperCase().trim();
  to   = String(to   || '').toUpperCase().trim();

  if (!from || !to) {
    return res.status(400).json({ error: 'from and to query params are required' });
  }

  if (!ALPHA_FX_KEY) {
    return res.status(500).json({ error: 'ALPHA_FX_KEY is not configured on the server' });
  }

  if (from === to) {
    return res.json({
      fromCurrency: from,
      toCurrency: to,
      rate: 1,
      lastUpdated: new Date().toISOString(),
      provider: 'alpha_vantage'
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
    const resp = await axios.get(url);
    const payload = resp.data['Realtime Currency Exchange Rate'];

    if (!payload || !payload['5. Exchange Rate']) {
      throw new Error('Bad FX response from Alpha Vantage');
    }

    const rate = parseFloat(payload['5. Exchange Rate']);
    if (!Number.isFinite(rate)) {
      throw new Error('FX rate is not a number');
    }

    const body = {
      fromCurrency: payload['1. From_Currency Code'],
      toCurrency:   payload['3. To_Currency Code'],
      rate,
      lastUpdated:  payload['6. Last Refreshed'],
      provider:     'alpha_vantage'
    };

    cache.set(cacheKey, { timestamp: now, value: body });

    res.json(body);
  } catch (err) {
    console.error('Error in /fx:', err);
    res.status(500).json({
      error: 'Failed to fetch FX',
      message: String(err)
    });
  }
});


app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});


