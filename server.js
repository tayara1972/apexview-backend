require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// Port (Render will inject PORT for you in production)
const PORT = process.env.PORT || 3000;

// Allow requests from anywhere for now (can be restricted later)
app.use(cors());

// Simple in-memory cache
// key: "AAPL,MSFT"  ->  { timestamp: number, data: { [symbol]: { date, close } } }
const cache = new Map();

// 60 minutes cache (as you requested)
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

function normalizeSymbols(symbolsArray) {
  return symbolsArray
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function makeCacheKey(symbolsArray) {
  return normalizeSymbols(symbolsArray).sort().join(",");
}

// Fetch quotes from Yahoo Finance (no API key needed)
async function fetchQuotesFromYahoo(symbols) {
  const url = "https://query1.finance.yahoo.com/v7/finance/quote";

  const normalizedSymbols = normalizeSymbols(symbols);
  if (normalizedSymbols.length === 0) {
    throw new Error("No valid symbols to request from Yahoo");
  }

  const params = {
    symbols: normalizedSymbols.join(",")
  };

  const response = await axios.get(url, { params });
  const data = response.data;

  if (!data || !data.quoteResponse || !Array.isArray(data.quoteResponse.result)) {
    throw new Error("Unexpected Yahoo Finance response format");
  }

  const results = data.quoteResponse.result;

  // Map results by symbol
  const mapped = {};

  for (const item of results) {
    const symbol = (item.symbol || "").toUpperCase();
    if (!symbol) continue;

    const prevClose = item.regularMarketPreviousClose;
    const timestamp = item.regularMarketTime; // Unix seconds

    if (prevClose == null) {
      // If there is no previous close, skip this symbol
      continue;
    }

    const date =
      timestamp != null
        ? new Date(timestamp * 1000).toISOString().slice(0, 10)
        : null;

    mapped[symbol] = {
      date,
      close: prevClose
    };
  }

  if (Object.keys(mapped).length === 0) {
    throw new Error("No Yahoo Finance data returned for requested symbols");
  }

  return mapped;
}

// Health check route
app.get("/", (req, res) => {
  res.send("ApexView quotes backend is running (Yahoo Finance)");
});

// Main endpoint: GET /quotes?symbols=AAPL,MSFT
app.get("/quotes", async (req, res) => {
  try {
    const symbolsParam = req.query.symbols;
    if (!symbolsParam) {
      return res.status(400).json({ error: "Missing symbols query parameter" });
    }

    const symbols = normalizeSymbols(symbolsParam.split(","));
    if (symbols.length === 0) {
      return res.status(400).json({ error: "No valid symbols provided" });
    }

    const cacheKey = makeCacheKey(symbols);
    const now = Date.now();

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL_MS) {
      return res.json({
        source: "cache",
        data: cached.data
      });
    }

    // Fetch fresh data from Yahoo Finance once for all symbols
    const yahooData = await fetchQuotesFromYahoo(symbols);

    // Ensure we only return the symbols requested (and in requested order)
    const responseData = {};
    for (const sym of symbols) {
      if (yahooData[sym]) {
        responseData[sym] = yahooData[sym];
      }
    }

    if (Object.keys(responseData).length === 0) {
      throw new Error("No quotes available for requested symbols");
    }

    const responseBody = {
      source: "live",
      data: responseData
    };

    // Update cache
    cache.set(cacheKey, {
      timestamp: now,
      data: responseBody.data
    });

    res.json(responseBody);
  } catch (err) {
    console.error("Error in /quotes:", err.message);
    res.status(500).json({
      error: "Failed to fetch quotes",
      message: err.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`ApexView backend (Yahoo) listening on port ${PORT}`);
});
