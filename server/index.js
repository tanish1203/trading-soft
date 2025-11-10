// server/index.js
// Pure backend: Express + Socket.IO + your market/game logic

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const OrderBook = require("./orderbook");

// --- env ---
const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "incorect";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// --- app / io ---
const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
});


/*
game = {
  markets: Map<symbol, {
    open: boolean,
    settlement: number|null,
    clickSizeDefault: number,
    userStats: Map<userId, { buyVol, buyNotional, sellVol, sellNotional }>,
    tape: Array<{ts, symbol, price, qty}>,
    book: OrderBook
  }>,
  usernames: Map<socketId, string>,
  roles: Map<socketId, 'player'|'admin'>,
  events: Array<{ts:number, text:string}>
}
*/
const games = new Map();
const MAX_MARKETS = 5;
const room = (code) => `game-${code}`;

// --- helpers ---
function impliedPx(mk) {
  if (mk.settlement != null) return mk.settlement;
  const mid = mk.book.mid();
  return mid != null ? mid : 0;
}
function marketMeta(mk) {
  return {
    symbol: mk.book.symbol,
    open: mk.open,
    settlement: mk.settlement,
    posLimit: mk.book.posLimit,
    clickSize: mk.clickSizeDefault || 1,
    bestBid: mk.book.bestBid(),
    bestAsk: mk.book.bestAsk(),
    tickSize: mk.book.tickSize,
  };
}
function packMarketsMeta(g) {
  return { markets: [...g.markets.values()].map(marketMeta) };
}
function ensureGameAdminCreate(code, defs) {
  if (games.has(code)) return games.get(code);
  const g = {
    markets: new Map(),
    usernames: new Map(),
    roles: new Map(),
    events: [],
  };
  defs.slice(0, MAX_MARKETS).forEach((d) => {
    const symbol = String(d.symbol || "").toUpperCase().slice(0, 16) || "A";
    const mk = {
      open: true,
      settlement: null,
      clickSizeDefault: 1,
      userStats: new Map(),
      tape: [],
      book: null,
    };
    mk.book = new OrderBook({
      symbol,
      tickSize: d.tickSize ?? 0.1,
      posLimit: d.posLimit ?? 100,
      onTrade: (t) => onTradeHook(code, symbol, t),
    });
    g.markets.set(symbol, mk);
  });
  games.set(code, g);
  return g;
}
function onTradeHook(code, symbol, t) {
  const g = games.get(code);
  if (!g) return;
  const mk = g.markets.get(symbol);
  if (!mk) return;

  mk.tape.push({ ts: t.ts, symbol, price: t.price, qty: t.qty });
  if (mk.tape.length > 1000) mk.tape.shift();

  // per-user stats
  const upd = (uid, side, qty, px) => {
    if (!mk.userStats.has(uid))
      mk.userStats.set(uid, {
        buyVol: 0,
        buyNotional: 0,
        sellVol: 0,
        sellNotional: 0,
      });
    const s = mk.userStats.get(uid);
    if (side === "buy") {
      s.buyVol += qty;
      s.buyNotional += qty * px;
    } else {
      s.sellVol += qty;
      s.sellNotional += qty * px;
    }
  };
  upd(t.buyer, "buy", t.qty, t.price);
  upd(t.seller, "sell", t.qty, t.price);

  io.to(room(code)).emit("trade", { ts: t.ts, symbol, price: t.price, qty: t.qty });
  fanout(code);
}
function sendPersonalBundle(socket, code) {
  const g = games.get(code);
  if (!g) return;

  socket.emit("markets_meta", packMarketsMeta(g));
  socket.emit("events", g.events.slice(-200));

  let total = 0;
  for (const [symbol, mk] of g.markets.entries()) {
    socket.emit("book_snapshot", { symbol, ...mk.book.snapshotFor(socket.id) });

    const pos = mk.book.getPosPublic(socket.id);
    socket.emit("position", { symbol, ...pos, name: g.usernames.get(socket.id) || null });

    const st =
      mk.userStats.get(socket.id) || {
        buyVol: 0,
        buyNotional: 0,
        sellVol: 0,
        sellNotional: 0,
      };
    const avgBuy = st.buyVol > 0 ? st.buyNotional / st.buyVol : 0;
    const avgSell = st.sellVol > 0 ? st.sellNotional / st.sellVol : 0;
    socket.emit("user_summary", {
      symbol,
      position: pos.qty || 0,
      avgBuy,
      avgSell,
      buyVol: st.buyVol,
      sellVol: st.sellVol,
    });

    total += (pos.cash || 0) + (pos.qty || 0) * impliedPx(mk);
  }
  socket.emit("pnl_implied", { total });
}
function fanout(code) {
  const g = games.get(code);
  if (!g) return;
  const r = io.sockets.adapter.rooms.get(room(code));
  if (!r) return;
  for (const id of r) {
    const s = io.sockets.sockets.get(id);
    if (s) sendPersonalBundle(s, code);
  }
}

// --- sockets ---
io.on("connection", (socket) => {
  // ADMIN CREATE
  socket.on("admin_create_game", ({ code, adminPassword, markets }) => {
    if (adminPassword !== ADMIN_PASSWORD)
      return socket.emit("admin_ack", { ok: false, error: "Bad password" });
    if (!/^\d{4}$/.test(String(code || "")))
      return socket.emit("admin_ack", { ok: false, error: "Code must be 4 digits" });

    const g = ensureGameAdminCreate(code, markets || []);
    g.roles.set(socket.id, "admin");
    g.usernames.set(socket.id, "Admin");

    socket.data.code = code;
    socket.join(room(code));
    socket.emit("admin_ack", { ok: true, code, ...packMarketsMeta(g) });
    sendPersonalBundle(socket, code);
  });

  // PLAYER JOIN
  socket.on("player_join", ({ code, name }) => {
    const g = games.get(String(code || ""));
    if (!g) return socket.emit("join_ack", { ok: false, error: "Game not found" });

    const display = String(name || "").slice(0, 24) || `Player-${socket.id.slice(0, 4)}`;
    g.roles.set(socket.id, "player");
    g.usernames.set(socket.id, display);

    socket.data.code = String(code);
    socket.join(room(code));
    socket.emit("join_ack", { ok: true, code, name: display, ...packMarketsMeta(g) });
    sendPersonalBundle(socket, code);
  });

  // ADMIN: open/close per market and all markets
  socket.on("admin_toggle_market", ({ symbol, open }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    if (g.roles.get(socket.id) !== "admin") return;
    const mk = g.markets.get(symbol);
    if (!mk) return;
    mk.open = !!open;
    io.to(room(socket.data.code)).emit("markets_meta", packMarketsMeta(g));
    fanout(socket.data.code);
  });

  socket.on("admin_toggle_all", ({ open }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    if (g.roles.get(socket.id) !== "admin") return;
    for (const mk of g.markets.values()) mk.open = !!open;
    io.to(room(socket.data.code)).emit("markets_meta", packMarketsMeta(g));
    fanout(socket.data.code);
  });

  // ADMIN: settle
  socket.on("admin_settle", ({ symbol, price }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    if (g.roles.get(socket.id) !== "admin") return;
    const mk = g.markets.get(symbol);
    if (!mk) return;

    const px = OrderBook.snap(+price, mk.book.tickSize);
    mk.settlement = px;
    mk.open = false;

    io.to(room(socket.data.code)).emit("markets_meta", packMarketsMeta(g));
    fanout(socket.data.code);
  });

  socket.on("admin_settle_all", ({ priceMap }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    if (g.roles.get(socket.id) !== "admin") return;
    for (const [sym, v] of Object.entries(priceMap || {})) {
      const mk = g.markets.get(sym);
      if (!mk) continue;
      const px = OrderBook.snap(+v, mk.book.tickSize);
      mk.settlement = px;
      mk.open = false;
    }
    io.to(room(socket.data.code)).emit("markets_meta", packMarketsMeta(g));
    fanout(socket.data.code);
  });

  // ADMIN: broadcast events
  socket.on("admin_add_event", ({ text }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    if (g.roles.get(socket.id) !== "admin") return;
    const msg = { ts: Date.now(), text: String(text || "").slice(0, 500) };
    g.events.push(msg);
    if (g.events.length > 500) g.events.shift();
    io.to(room(socket.data.code)).emit("event", msg);
  });

  // TRADING
  socket.on("place_order", ({ symbol, side, price, qty }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    const mk = g.markets.get(symbol);
    if (!mk || !mk.open) return;
    if (!["buy", "sell"].includes(side)) return;
    if (!(price > 0 && qty > 0)) return;

    const res = mk.book.placeLimit({ userId: socket.id, side, price: +price, qty: +qty });
    if (res && res.rejected) {
      socket.emit("order_reject", { symbol, reason: res.reason });
      return;
    }
    fanout(socket.data.code);
  });

  socket.on("cancel_at_price", ({ symbol, side, price }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    const mk = g.markets.get(symbol);
    if (!mk) return;
    mk.book.cancelAtPrice({ userId: socket.id, side, price: +price });
    fanout(socket.data.code);
  });

  socket.on("click_trade", ({ symbol, side, price, maxQty }) => {
    const g = games.get(socket.data.code);
    if (!g) return;
    const mk = g.markets.get(symbol);
    if (!mk || !mk.open) return;
    mk.book.takeAtPrice({
      userId: socket.id,
      side,
      price: +price,
      maxQty: Math.max(1, +maxQty || 1),
    });
    fanout(socket.data.code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (code && games.has(code)) {
      const g = games.get(code);
      g.usernames.delete(socket.id);
      g.roles.delete(socket.id);
    }
  });
});

// --- start ---
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
