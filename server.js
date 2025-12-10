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

app.get('/quotes', async (req, res) => {
  const symbolsParam = req.query.symbols;
  if (!symbolsParam) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }

  const symbols = symbolsParam
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' });
  }

  if (!FINNHUB_API_KEY) {
    return res.status(500).json({
      error: 'Missing FINNHUB_API_KEY',
      message: 'Set FINNHUB_API_KEY in your environment',
    });
  }

  const data = {};

  try {
    for (const symbol of symbols) {
      const url =
        'https://finnhub.io/api/v1/quote?symbol=' +
        encodeURIComponent(symbol) +
        '&token=' +
        encodeURIComponent(FINNHUB_API_KEY);

      const resp = await fetch(url);
      if (!resp.ok) {
        console.error('Finnhub quote error', symbol, resp.status, await resp.text());
        continue;
      }

      const q = await resp.json();

      data[symbol] = {
        symbol,
        previousClose: q.pc ?? null,
        current:       q.c  ?? null,
        high:          q.h  ?? null,
        low:           q.l  ?? null,
        open:          q.o  ?? null,
        provider: 'finnhub',
      };
    }

    // Ensure every requested symbol has an entry
    for (const s of symbols) {
      if (!data[s]) {
        data[s] = {
          symbol: s,
          previousClose: null,
          current: null,
          high: null,
          low: null,
          open: null,
          provider: 'finnhub',
        };
      }
    }

    res.json({
      source: 'live',
      data,
    });
  } catch (err) {
    console.error('Error in /quotes:', err);
    res.status(500).json({
      error: 'Failed to fetch quotes',
      message: String(err),
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
