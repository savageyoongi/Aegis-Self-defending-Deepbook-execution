/**
 * Aegis API Server
 * Exposes the risk engine and duel simulator over HTTP.
 * Deploy to Railway — set PORT env var (Railway injects it automatically).
 */

import http from "http";
import { normalizeIntent, getSampleBook, computeRisk, planGrid, simulateDuel } from "../engine/src/core/index.js";

const PORT = process.env.PORT || 3001;

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // GET /api/health
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { status: "ok", ts: Date.now() });
    }

    // POST /api/plan  — risk score + grid plan for an intent
    if (req.method === "POST" && url.pathname === "/api/plan") {
      const body = await readBody(req);
      const intent = normalizeIntent({
        pair:           body.pair           ?? "SUI_DBUSDC",
        side:           body.side           ?? "buy",
        quantity:       Number(body.quantity        ?? 100),
        maxSlippageBps: Number(body.maxSlippageBps  ?? 80),
        urgency:        body.urgency        ?? "normal",
      });
      const book = getSampleBook(body.scenario ?? "toxic");
      const risk = computeRisk(book, intent);
      const plan = planGrid(intent, book, risk);
      return json(res, 200, { intent, risk, plan });
    }

    // POST /api/duel  — full predator vs Aegis simulation
    if (req.method === "POST" && url.pathname === "/api/duel") {
      const body = await readBody(req);
      const intent = normalizeIntent({
        pair:           body.pair           ?? "SUI_DBUSDC",
        side:           body.side           ?? "buy",
        quantity:       Number(body.quantity        ?? 100),
        maxSlippageBps: Number(body.maxSlippageBps  ?? 80),
        urgency:        body.urgency        ?? "normal",
      });
      const book = getSampleBook(body.scenario ?? "toxic");
      const result = simulateDuel(intent, book);
      return json(res, 200, result);
    }

    // GET /api/scenarios — list available market scenarios
    if (req.method === "GET" && url.pathname === "/api/scenarios") {
      return json(res, 200, { scenarios: ["calm", "stressed", "toxic"] });
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Aegis API running on port ${PORT}`);
});
