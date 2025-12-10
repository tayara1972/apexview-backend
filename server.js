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

// Helpful warning in the logs if the key is missing
if (!FINNHUB_API_KEY) {
  console.warn('WARNING: FINNHUB_API_KEY is not set. Quotes will fail.');
}

app.use(morgan('dev'));
app.use(cors());

// Healthcheck
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
 * Stocks like AAPL, MSFT, TSLA are passed through.
 * Crypto is mapped to Coinbase pairs.
 */
function mapToFinnhubSymbol(raw) {
  const s = raw.toUpperCase().trim();

  // Crypto shortcuts. Extend when needed.
  if (s === 'BTC' || s === 'BTC-USD') {
    return 'COINBASE:BTC-USD';
  }

  if (s === 'ETH' || s === 'ETH-USD') {
    return 'COINBASE:ETH-USD';
  }

  if (s === 'SOL' || s === 'SOL-USD') {
    return 'COINBASE:SOL-USD';
  }

  if (s === 'ADA' || s === 'ADA-USD') {
    return 'COINBASE:ADA-USD';
  }

  if (s === 'DOGE' || s === 'DOGE-USD') {
    return 'COINBASE:DOGE-USD';
  }

  // Default: stock or ETF ticker that Finnhub already understands
  return s;
}

/**
 * GET /quotes?symbols=AAPL,BTC-USD,ETH-USD
 *
 * Returns:
 * {
 *   "source": "live",
 *   "data": {
 *     "AAPL": { ... },
 *     "BTC-USD": { ... },
 *     "ETH-USD": { ... }
 *   }
 * }
 */
app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;

  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  const rawSymbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (rawSymbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'FINNHUB_API_KEY is not configured on the server'
    });
  }

  // Pair each original symbol with its Finnhub symbol
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
          // Keep your app's original symbol in the payload
          result[raw] = {
            ...cached.value,
            symbol: raw
          };
          return;
        }

        // Cache miss, go to Finnhub
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

          // q.pc = previous close, q.c = current
          const value = {
            symbol: raw,
            previousClose: typeof q.pc === 'number' ? q.pc : null,
            current:       typeof q.c  === 'number' ? q.c  : null,
            high:          typeof q.h  === 'number' ? q.h  : null,
            low:           typeof q.l  === 'number' ? q.l  : null,
            open:          typeof q.o  === 'number' ? q.o  : null,
            provider: 'finnhub'
          };

          // Store in cache keyed by the Finnhub symbol
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

          // Graceful fallback, all nulls
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

app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});
