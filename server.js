require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// Read configuration from environment
const PORT = process.env.PORT || 3000;
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_API_KEY;

if (!ALPHA_VANTAGE_KEY) {
  console.error("Missing ALPHA_VANTAGE_API_KEY in .env");
  process.exit(1);
}

// Allow requests from your iOS app and, for now, from anywhere during development
app.use(cors());

// Simple in memory cache: key -> { timestamp, data }
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes


function normalizeSymbols(symbolsArray) {
  return symbolsArray
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function makeCacheKey(symbolsArray) {
  return normalizeSymbols(symbolsArray).sort().join(",");
}

// Use GLOBAL_QUOTE to get latest trading day and previous close
async function fetchPreviousClose(symbol) {
  const url = "https://www.alphavantage.co/query";

  const params = {
    function: "GLOBAL_QUOTE",
    symbol: symbol,
    apikey: ALPHA_VANTAGE_KEY
  };

  const response = await axios.get(url, { params });
  const data = response.data;

  // Debug logging, can remove later
  // console.log("GLOBAL_QUOTE response for", symbol, JSON.stringify(data).slice(0, 300));

  if (data["Error Message"]) {
    throw new Error(`Alpha Vantage error for ${symbol}: ${data["Error Message"]}`);
  }

  if (data["Note"]) {
    throw new Error(`Alpha Vantage note for ${symbol}: ${data["Note"]}`);
  }

  const quote = data["Global Quote"];
  if (!quote) {
    throw new Error(`No Global Quote returned for ${symbol}`);
  }

  const prevCloseStr = quote["08. previous close"];
  const latestTradingDay = quote["07. latest trading day"];

  if (!prevCloseStr || !latestTradingDay) {
    throw new Error(`Missing previous close or latest trading day for ${symbol}`);
  }

  const close = parseFloat(prevCloseStr);

  return {
    symbol,
    date: latestTradingDay,
    close
  };
}

// Health check route
app.get("/", (req, res) => {
  res.send("ApexView quotes backend is running");
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

    // Fetch fresh data from Alpha Vantage for each symbol
    const results = await Promise.all(symbols.map((s) => fetchPreviousClose(s)));

    const data = {};
    for (const item of results) {
      data[item.symbol] = {
        date: item.date,
        close: item.close
      };
    }

    const responseBody = {
      source: "live",
      data
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
  console.log(`ApexView backend listening on port ${PORT}`);
});
