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

app.use(morgan('dev'));
app.use(cors());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ApexView quotes backend',
    provider: 'finnhub',
    cacheTtlMinutes: CACHE_TTL_MS / 60000
  });
});

// server.js

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

function mapToFinnhubSymbol(raw) {
  const s = raw.toUpperCase().trim();

  // BTC and ETH shortcuts. You can extend this later.

  if (s === 'BTC' || s === 'BTC-USD') {
    // Coinbase BTC-USD pair
    return 'COINBASE:BTC-USD';
  }

  if (s === 'ETH' || s === 'ETH-USD') {
    // Coinbase ETH-USD pair
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

  // Everything else is treated as a regular stock or ETF ticker.
  // For example AAPL, MSFT, TSLA work directly with Finnhub stocks.
  return s;
}


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

  // Pair each original symbol with its Finnhub symbol
  const pairs = rawSymbols.map(raw => ({
    raw,
    finnhub: mapToFinnhubSymbol(raw)
  }));

  const result = {};

  try {
    await Promise.all(
      pairs.map(async ({ raw, finnhub }) => {
        try {
          const url =
            'https://finnhub.io/api/v1/quote?symbol=' +
            encodeURIComponent(finnhub) +
            '&token=' +
            FINNHUB_KEY;

          const resp = await fetch(url);

          if (!resp.ok) {
            throw new Error('Finnhub status ' + resp.status);
          }

          const json = await resp.json();

          // Finnhub fields: c=current, pc=previous close, h=high, l=low, o=open
          result[raw] = {
            symbol: raw,
            previousClose: json.pc ?? null,
            current: json.c ?? null,
            high: json.h ?? null,
            low: json.l ?? null,
            open: json.o ?? null,
            provider: 'finnhub'
          };
        } catch (innerErr) {
          console.error('Error fetching quote for', raw, 'mapped as', finnhub, innerErr);
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




async function fetchQuotesFromFinnhub(symbols) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error('FINNHUB_API_KEY is not set');
  }

  const baseUrl = 'https://finnhub.io/api/v1/quote';

  const results = {};

  const promises = symbols.map(async (symbol) => {
    const url = `${baseUrl}?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
    const response = await axios.get(url);

    if (response.status !== 200) {
      throw new Error(`Finnhub request for ${symbol} failed with status ${response.status}`);
    }

    const q = response.data;
    // q.pc = previous close, q.c = current price
    if (!q || typeof q.pc !== 'number') {
      throw new Error(`Invalid quote data for ${symbol}`);
    }

    results[symbol] = {
      symbol,
      previousClose: q.pc,
      current: typeof q.c === 'number' ? q.c : null,
      high: typeof q.h === 'number' ? q.h : null,
      low: typeof q.l === 'number' ? q.l : null,
      open: typeof q.o === 'number' ? q.o : null,
      provider: 'finnhub'
    };
  });

  await Promise.all(promises);

  return results;
}

app.listen(PORT, () => {
  console.log(`ApexView quotes backend listening on port ${PORT}`);
});
