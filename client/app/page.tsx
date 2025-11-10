"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

/* ---------------- helpers ---------------- */

function snapToTick(px: number, tick: number) {
  const t = Math.max(0.000001, +tick || 0.01);
  return Math.round(px / t) * t;
}



function fmtTimeUK(ts: number) {
  return new Date(ts).toLocaleString("en-GB", { timeZone: "Europe/London", hour12: false });
}

function toFixed2(n: number) {
  return Number.isFinite(n) ? n.toFixed(2) : "-";
}

function isTickAligned(price: number, tick: number) {
  const t = Math.max(0.000001, +tick || 0.01);
  const k = Math.round(price / t);
  return Math.abs(price - k * t) < 1e-9;
}

type Level = { price: number; size: number; my: number };
type Book = { symbol: string; bids: Level[]; asks: Level[] };
type MarketMeta = {
  symbol: string;
  open: boolean;
  settlement: number | null;
  posLimit: number;
  clickSize: number;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number | null;
};

/* ---------- component ---------- */

export default function Home() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  // who am I
  const [isAdmin, setIsAdmin] = useState(false);
  const [displayName, setDisplayName] = useState<string>("");

  // theme & prefs
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // lobby
  const [mode, setMode] = useState<"landing" | "admin" | "player" | "game">("landing");
  const [code, setCode] = useState("");
  const [adminPw, setAdminPw] = useState("");
  const [username, setUsername] = useState("");

  // admin create markets
  const [mkDefs, setMkDefs] = useState<{ symbol: string; posLimit: number; tickSize: number }[]>([
    { symbol: "A", posLimit: 100, tickSize: 0.1 },
  ]);

  // game state
  const [markets, setMarkets] = useState<MarketMeta[]>([]);
  const [books, setBooks] = useState<Record<string, Book>>({});
  const [positions, setPositions] = useState<Record<string, { qty: number; cash: number }>>({});
  const [implied, setImplied] = useState<number>(0);

  // per-player summary & dashboards
  const [summ, setSumm] = useState<
    Record<string, { position: number; avgBuy: number; avgSell: number; buyVol: number; sellVol: number }>
  >({});
  const [tape, setTape] = useState<{ ts: number; symbol: string; price: number; qty: number }[]>([]);
  const [events, setEvents] = useState<{ ts: number; text: string }[]>([]);

  // per-player, per-market click size & center lock
  const [clickSize, setClickSize] = useState<Record<string, number>>({});
  const [centerLock, setCenterLock] = useState<Record<string, boolean>>({});

  // ladder windows per market (auto-extends)
  type LadderWin = { min: number; max: number };
  const [ladderWin, setLadderWin] = useState<Record<string, LadderWin>>({});
  const scrollers = useRef<Record<string, HTMLDivElement | null>>({});

/* ---------- sockets ---------- */
useEffect(() => {
  // Avoid double-connect in React StrictMode (Next dev)
  let isActive = true;

  // Prefer env var in prod; fallback to localhost for local dev
  const serverUrl =
    process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";

  const s = io(serverUrl, { transports: ["websocket"] });
  setSocket(s);

  // --- connection status ---
  s.on("connect", () => isActive && setConnected(true));
  s.on("disconnect", () => isActive && setConnected(false));
  s.on("connect_error", (err) => {
    console.error("Socket connect_error:", err?.message || err);
  });

  // --- auth / join acks ---
  s.on("admin_ack", (res: any) => {
    if (!isActive) return;
    if (!res?.ok) return alert(res?.error || "Admin create failed");
    setIsAdmin(true);
    setDisplayName("Admin");
    setMode("game");
    if (res.markets) setMarkets(res.markets);
  });

  s.on("join_ack", (res: any) => {
    if (!isActive) return;
    if (!res?.ok) return alert(res?.error || "Join failed");
    setIsAdmin(false);
    setDisplayName(res.name || "");
    setMode("game");
    if (res.markets) setMarkets(res.markets);
  });

  // --- streams / updates ---
  s.on("markets_meta", (p: { markets: MarketMeta[] }) => {
    if (!isActive) return;
    setMarkets(p.markets || []);
  });

  s.on("book_snapshot", (snap: Book) => {
    if (!isActive) return;
    setBooks((prev) => ({ ...prev, [snap.symbol]: snap }));
  });

  s.on("position", (p: { symbol: string; qty: number; cash: number }) => {
    if (!isActive) return;
    setPositions((prev) => ({ ...prev, [p.symbol]: { qty: p.qty, cash: p.cash } }));
  });

  s.on(
    "user_summary",
    (u: {
      symbol: string;
      position: number;
      avgBuy: number;
      avgSell: number;
      buyVol: number;
      sellVol: number;
    }) => {
      if (!isActive) return;
      setSumm((prev) => ({ ...prev, [u.symbol]: u }));
    },
  );

  s.on("pnl_implied", (p: { total: number }) => {
    if (!isActive) return;
    setImplied(p.total || 0);
  });

  s.on("events", (arr: { ts: number; text: string }[]) => {
    if (!isActive) return;
    setEvents(arr || []);
  });

  s.on("event", (e: { ts: number; text: string }) => {
    if (!isActive) return;
    setEvents((prev) => [...prev, e].slice(-200));
  });

  s.on("trade", (t: { ts: number; symbol: string; price: number; qty: number }) => {
    if (!isActive) return;
    setTape((prev) => [t, ...prev].slice(0, 500));
  });

  s.on("order_reject", (r: any) => {
    if (!isActive) return;
    if (r?.reason === "pos_limit")
      alert("Cannot execute since doing trade would put you over position limit.");
  });

  // cleanup
  return () => {
    isActive = false;
    s.removeAllListeners();
    s.disconnect();
  };
}, []);

  /* ---------- actions ---------- */

  // Lobby
  const createGame = () => {
    if (!socket) return;
    if (!/^\d{4}$/.test(code)) return alert("Code must be 4 digits");
    if (!mkDefs.length || mkDefs.length > 5) return alert("1 to 5 markets");
    socket.emit("admin_create_game", { code, adminPassword: adminPw, markets: mkDefs });
  };
  const joinGame = () => {
    if (!socket) return;
    if (!/^\d{4}$/.test(code)) return alert("Code must be 4 digits");
    if (!username.trim()) return alert("Enter username");
    socket.emit("player_join", { code, name: username.trim() });
  };

  // Trading
  const placeOrder = (symbol: string, side: "buy" | "sell", price: number, qty: number, tick: number, posLimit: number) => {
    // client pre-checks
    if (!(price > 0 && qty > 0)) return alert("Price and quantity must be positive.");
    if (!isTickAligned(price, tick)) return alert(`Price must be in multiples of ${tick}.`);
    const pos = positions[symbol] || { qty: 0, cash: 0 };
    const newQty = side === "buy" ? pos.qty + qty : pos.qty - qty;
    if (Math.abs(newQty) > posLimit) return alert("Cannot execute since doing trade would put you over position limit.");

    socket?.emit("place_order", { symbol, side, price, qty });
  };
  const cancelAt = (symbol: string, side: "buy" | "sell", price: number) =>
    socket?.emit("cancel_at_price", { symbol, side, price });
  const clickTrade = (symbol: string, side: "buy" | "sell", price: number, qty: number) =>
    socket?.emit("click_trade", { symbol, side, price, maxQty: qty });

  // Admin controls
  const toggleMarket = (symbol: string, open: boolean) => socket?.emit("admin_toggle_market", { symbol, open });
  const toggleAll = (open: boolean) => socket?.emit("admin_toggle_all", { open });
  const settleOne = (symbol: string, v: number) => {
    if (v > 0) socket?.emit("admin_settle", { symbol, price: v });
  };
  const settleAll = () => {
    if (!markets.length) return;
    const m: Record<string, number> = {};
    for (const mk of markets) {
      const v = Number(prompt(`Settlement for ${mk.symbol} (blank=skip):`) || "");
      if (v > 0) m[mk.symbol] = v;
    }
    socket?.emit("admin_settle_all", { priceMap: m });
  };
  const sendEvent = (text: string) => socket?.emit("admin_add_event", { text });

  /* ---------- ladder logic per market ---------- */

  // whenever metadata changes, initialize window + click size defaults + center lock default
  useEffect(() => {
    setLadderWin((prev) => {
      const copy = { ...prev };
      for (const mk of markets) {
        // ✅ Ensure tick size is positive
        const t = Math.max(0.000001, mk.tickSize ?? 0.1);
  
        // Compute a reasonable mid
        const rawMid =
          mk.settlement != null
            ? mk.settlement
            : mk.bestBid != null && mk.bestAsk != null
            ? (mk.bestBid + mk.bestAsk) / 2
            : mk.bestBid ?? mk.bestAsk ?? t * 100;
  
        // ✅ Snap mid to nearest valid tick multiple
        const mid = Math.round(rawMid / t) * t;
  
        // Only initialize once per symbol
        if (!copy[mk.symbol]) {
          copy[mk.symbol] = { min: mid - 200 * t, max: mid + 200 * t };
        }
      }
      return copy;
    });
  
    // Ensure per-market click size initialized
    setClickSize((prev) => {
      const copy = { ...prev };
      for (const mk of markets) if (!copy[mk.symbol]) copy[mk.symbol] = 1;
      return copy;
    });
  
    // Ensure centerLock state initialized
    setCenterLock((prev) => {
      const copy = { ...prev };
      for (const mk of markets) if (copy[mk.symbol] == null) copy[mk.symbol] = true; // default locked
      return copy;
    });
  }, [markets]);
  

  // extend window on scroll near edges
  const onScroll = (symbol: string, tick: number) => {
    const el = scrollers.current[symbol];
    if (!el) return;
    const threshold = 120; // px
    // near top: extend up (higher prices)
    if (el.scrollTop < threshold) {
      setLadderWin((prev) => {
        const w = prev[symbol];
        if (!w) return prev;
        return { ...prev, [symbol]: { min: w.min, max: w.max + 200 * tick } };
      });
    }
    // near bottom: extend down (lower prices)
    if (el.scrollHeight - el.clientHeight - el.scrollTop < threshold) {
      setLadderWin((prev) => {
        const w = prev[symbol];
        if (!w) return prev;
        return { ...prev, [symbol]: { min: w.min - 200 * tick, max: w.max } };
      });
    }
  };

  // center button handler
  const recenter = (symbol: string, mk: MarketMeta) => {
    setCenterLock(prev => {
      const next = !prev[symbol];
  
      // Only reset/center when turning lock ON
      if (next) {
        const t = Math.max(0.000001, mk.tickSize ?? 0.1);
        const rawMid =
          mk.settlement != null
            ? mk.settlement
            : mk.bestBid != null && mk.bestAsk != null
            ? (mk.bestBid + mk.bestAsk) / 2
            : mk.bestBid ?? mk.bestAsk ?? t * 100;
  
        const mid = Math.round(rawMid / t) * t;
  
        setLadderWin(prevWin => ({ ...prevWin, [symbol]: { min: mid - 200 * t, max: mid + 200 * t } }));
        setTimeout(() => {
          const el = scrollers.current[symbol];
          if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
        }, 0);
      }
  
      return { ...prev, [symbol]: next };
    });
  };
  
  
  

  /* ---------- ui helpers ---------- */

  const gridCols = useMemo(() => {
    const n = Math.max(1, Math.min(5, markets.length || 1));
    return n <= 2 ? "grid-cols-2" : n === 3 ? "grid-cols-3" : n === 4 ? "grid-cols-4" : "grid-cols-5";
  }, [markets.length]);

  /* ---------- screens ---------- */

  if (mode === "landing") {
    return (
      <main className={(theme === "dark" ? "bg-black text-white" : "bg-white text-zinc-900") + " min-h-screen p-6 space-y-6"}>
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Trading Sim Lobby</h1>
          <div className="flex items-center gap-3">
            <span className="text-sm">{connected ? "✅ Connected" : "❌ Disconnected"}</span>
            <button
              className="border border-zinc-500 rounded px-2 py-1"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
            </button>
          </div>
        </header>

        <div className="flex gap-4">
          <button className="bg-blue-600 rounded px-3 py-2 text-white" onClick={() => setMode("admin")}>
            Admin
          </button>
          <button className="bg-zinc-700 rounded px-3 py-2 text-white" onClick={() => setMode("player")}>
            Player
          </button>
        </div>
      </main>
    );
  }

  if (mode === "admin") {
    return (
      <main className={(theme === "dark" ? "bg-black text-white" : "bg-white text-zinc-900") + " min-h-screen p-6 space-y-6"}>
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Create Game (Admin)</h2>
          <button
            className="border border-zinc-500 rounded px-2 py-1"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>
        </header>
        <div className="space-y-3 max-w-xl">
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
            placeholder="4-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
            placeholder="Admin password (incorect)"
            value={adminPw}
            onChange={(e) => setAdminPw(e.target.value)}
          />
          <div className="space-y-2">
            <div className="text-sm text-zinc-400">Markets (1–5)</div>
            {mkDefs.map((m, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-24"
                  value={m.symbol}
                  onChange={(e) => {
                    const v = e.target.value.toUpperCase();
                    setMkDefs((d) => d.map((x, idx) => (idx === i ? { ...x, symbol: v } : x)));
                  }}
                />
                <input
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-28"
                  value={m.posLimit}
                  onChange={(e) =>
                    setMkDefs((d) => d.map((x, idx) => (idx === i ? { ...x, posLimit: Number(e.target.value) || 0 } : x)))
                  }
                  placeholder="PosLimit"
                  type="number"
                  min={1}
                />
                <input
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 w-28"
                  value={m.tickSize}
                  onChange={(e) =>
                    setMkDefs((d) => d.map((x, idx) => (idx === i ? { ...x, tickSize: Number(e.target.value) || 0 } : x)))
                  }
                  placeholder="Tick"
                  type="number"
                  step="any"
                  min={0.000001}
                />
                <button className="bg-red-700 rounded px-2 py-1" onClick={() => setMkDefs((d) => d.filter((_, idx) => idx !== i))}>
                  X
                </button>
              </div>
            ))}
            {mkDefs.length < 5 && (
              <button
                className="bg-zinc-700 rounded px-3 py-1"
                onClick={() => setMkDefs((d) => [...d, { symbol: "X", posLimit: 100, tickSize: 0.1 }])}
              >
                + Add market
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button className="bg-blue-600 rounded px-3 py-2 text-white" onClick={createGame}>
              Create & Enter
            </button>
            <button className="underline" onClick={() => setMode("landing")}>
              Back
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (mode === "player") {
    return (
      <main className={(theme === "dark" ? "bg-black text-white" : "bg-white text-zinc-900") + " min-h-screen p-6 space-y-6"}>
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Join Game (Player)</h2>
          <button
            className="border border-zinc-500 rounded px-2 py-1"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>
        </header>
        <div className="space-y-3 max-w-md">
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
            placeholder="4-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <input
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button className="bg-blue-600 rounded px-3 py-2 text-white" onClick={joinGame}>
              Join
            </button>
            <button className="underline" onClick={() => setMode("landing")}>
              Back
            </button>
          </div>
        </div>
      </main>
    );
  }

  /* ---------- GAME UI ---------- */

  return (
    <main className={(theme === "dark" ? "bg-black text-white" : "bg-white text-zinc-900") + " min-h-screen p-6 space-y-6"}>
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Game {code}</h1>
          <span className="text-sm text-zinc-400">— {displayName || "Player"}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="px-3 py-2 rounded border border-zinc-700">
            <div className="text-sm text-zinc-400">Implied PnL</div>
            <div className="text-lg">{toFixed2(implied)}</div>
          </div>
          <button
            className="border border-zinc-500 rounded px-2 py-1"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          >
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>
        </div>
      </header>

      {/* Admin bar */}
      {isAdmin && !!markets.length && (
        <div className="border border-zinc-800 rounded-lg p-3 flex gap-3 flex-wrap">
          <span className="text-zinc-400">Admin controls:</span>
          <button className="bg-zinc-800 rounded px-3 py-1" onClick={() => toggleAll(true)}>
            Open all
          </button>
          <button className="bg-zinc-800 rounded px-3 py-1" onClick={() => toggleAll(false)}>
            Close all
          </button>
          <button className="bg-red-700 rounded px-3 py-1" onClick={settleAll}>
            Settle all…
          </button>
        </div>
      )}

      {/* Books grid */}
      <section className={`grid ${gridCols} gap-4`}>
        {markets.map((mk) => {
          const book = books[mk.symbol];
          const pos = positions[mk.symbol] || { qty: 0, cash: 0 };
          const t = Math.max(0.000001, mk.tickSize ?? 0.1);


          // compute mid
          const mid =
            mk.settlement != null
              ? mk.settlement
              : mk.bestBid != null && mk.bestAsk != null
              ? (mk.bestBid + mk.bestAsk) / 2
              : mk.bestBid ?? mk.bestAsk ?? t * 100;

          // ensure window exists
          const midSnap = Math.round(mid / t) * t;
          const win = ladderWin[mk.symbol] ?? { min: midSnap - 200 * t, max: midSnap + 200 * t };

          // collect book into price->sizes map for quick lookup
          const map: Record<number, { bid: number; myBid: number; ask: number; myAsk: number }> = {};
          if (book) {
            for (const l of book.bids) {
              const p = l.price;
              if (!map[p]) map[p] = { bid: 0, myBid: 0, ask: 0, myAsk: 0 };
              map[p].bid += l.size; map[p].myBid += l.my;
            }
            for (const l of book.asks) {
              const p = l.price;
              if (!map[p]) map[p] = { bid: 0, myBid: 0, ask: 0, myAsk: 0 };
              map[p].ask += l.size; map[p].myAsk += l.my;
            }
          }

          // ✅ build prices descending (high → low) on exact multiples of tick
          // ✅ align loop bounds to the tick grid
          const maxTick = Math.floor(win.max / t) * t;
          const minTick = Math.ceil(win.min / t) * t;

          // ✅ build prices descending (high → low) on exact multiples of tick
          const prices: number[] = [];
          for (let p = maxTick; p >= minTick; p -= t) {
            prices.push(Number(p.toFixed(10)));
          }



          const rows = prices.map((p) => ({
            price: p,
            bid: map[p]?.bid || 0,
            myBid: map[p]?.myBid || 0,
            ask: map[p]?.ask || 0,
            myAsk: map[p]?.myAsk || 0,
          }));

          const perPnL = (() => {
            const px =
              mk.settlement != null
                ? mk.settlement
                : mk.bestBid != null && mk.bestAsk != null
                ? (mk.bestBid + mk.bestAsk) / 2
                : mk.bestBid ?? mk.bestAsk ?? 0;
            return (pos.cash || 0) + (pos.qty || 0) * (px || 0);
          })();

          const myClick = Math.max(1, clickSize[mk.symbol] || 1);

          return (
            <div key={mk.symbol} className="border border-zinc-800 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold">
                    {mk.symbol}{" "}
                    {mk.open ? <span className="text-green-500">OPEN</span> : <span className="text-red-500">CLOSED</span>}
                  </h3>
                  <span className="text-sm text-zinc-400">PnL: {toFixed2(perPnL)}</span>
                  {mk.settlement != null && (
                    <span className="ml-2 text-sm rounded bg-zinc-800 px-2 py-0.5">Settled @ {mk.settlement}</span>
                  )}
                </div>

                <div className="flex gap-2 items-center">
                  {/* center toggle */}
                  <button
                    title="Center on mid"
                    className={"rounded px-2 py-1 border " + (centerLock[mk.symbol] ? "border-blue-500 text-blue-400" : "border-zinc-600")}
                    onClick={() => recenter(mk.symbol, mk)}
                  >
                    M
                  </button>

                  {/* per-player click size */}
                  <label className="rounded px-2 py-1 border border-zinc-700 flex items-center gap-2">
                    Click
                    <input
                      value={myClick}
                      type="number"
                      min={1}
                      className="w-16 bg-transparent border border-zinc-700 rounded px-1 py-0.5"
                      onChange={(e) =>
                        setClickSize((prev) => ({ ...prev, [mk.symbol]: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))
                      }
                    />
                  </label>

                  {/* admin per-market open/close + settle */}
                  {isAdmin && (
                    <>
                      <button
                        className="bg-zinc-800 rounded px-2 py-1"
                        onClick={() => toggleMarket(mk.symbol, !mk.open)}
                      >
                        {mk.open ? "Close" : "Open"}
                      </button>
                      <button
                        className="bg-red-700 rounded px-2 py-1"
                        onClick={() => {
                          const v = Number(prompt(`Settlement price for ${mk.symbol}:`) || "");
                          if (v > 0) settleOne(mk.symbol, v);
                        }}
                      >
                        Settle…
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="text-sm text-zinc-400 mb-2">
                Pos {pos.qty} | Cash {toFixed2(pos.cash)}
              </div>

              {/* ladder */}
              <div
                ref={(el: HTMLDivElement | null) => {
                  scrollers.current[mk.symbol] = el;
                }}
                
                onScroll={() => {
                  if (!centerLock[mk.symbol]) onScroll(mk.symbol, t);
                }}
                className="overflow-y-auto max-h-[48vh]"
                style={{ scrollBehavior: "auto" }}
              >
                <table className="w-full text-sm">
                  <thead className="sticky top-0" style={{ background: theme === "dark" ? "#000" : "#fff" }}>
                    <tr>
                      <th className="text-left w-14">My</th>
                      <th className="text-left w-20">Buy</th>
                      <th className="text-center">Price</th>
                      <th className="text-right w-20">Sell</th>
                      <th className="text-right w-14">My</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.price} className="border-b border-zinc-800">
                        {/* My Buy (cancel) */}
                        <td
                          onClick={() => r.myBid && cancelAt(mk.symbol, "buy", r.price)}
                          className={"cursor-pointer select-none text-left " + (r.myBid ? "" : "text-zinc-600")}
                          style={{ background: r.myBid ? "rgba(16,185,129,0.12)" : "transparent" }}
                        >
                          {r.myBid || ""}
                        </td>

                        {/* BUY column: lift ask if present, else place limit */}
                        <td
                          onClick={() => {
                            if (!mk.open) return;
                            if (r.ask > 0) clickTrade(mk.symbol, "buy", r.price, myClick);
                            else placeOrder(mk.symbol, "buy", r.price, myClick, t, mk.posLimit);
                          }}
                          className="cursor-pointer select-none"
                          style={{ background: "rgba(16,185,129,0.18)" }}
                        >
                          {r.bid || ""}
                        </td>

                        {/* PRICE */}
                        <td className="text-center">{toFixed2(r.price)}</td>

                        {/* SELL column: hit bid if present, else place limit */}
                        <td
                          onClick={() => {
                            if (!mk.open) return;
                            if (r.bid > 0) clickTrade(mk.symbol, "sell", r.price, myClick);
                            else placeOrder(mk.symbol, "sell", r.price, myClick, t, mk.posLimit);
                          }}
                          className="cursor-pointer select-none text-right"
                          style={{ background: "rgba(239,68,68,0.18)" }}
                        >
                          {r.ask || ""}
                        </td>

                        {/* My Sell (cancel) */}
                        <td
                          onClick={() => r.myAsk && cancelAt(mk.symbol, "sell", r.price)}
                          className={"cursor-pointer select-none text-right " + (r.myAsk ? "" : "text-zinc-600")}
                          style={{ background: r.myAsk ? "rgba(239,68,68,0.12)" : "transparent" }}
                        >
                          {r.myAsk || ""}
                        </td>
                      </tr>
                    ))}
                    {!rows.length && (
                      <tr>
                        <td colSpan={5} className="text-center text-zinc-600 py-4">
                          No orders
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ticket */}
              <Ticket
                symbol={mk.symbol}
                posLimit={mk.posLimit}
                tick={t}
                onSubmit={(side, price, qty) => placeOrder(mk.symbol, side, price, qty, t, mk.posLimit)}
              />
            </div>
          );
        })}
      </section>

      {/* Positions summary */}
      <section className="border border-zinc-800 rounded-lg p-4">
        <h2 className="font-semibold mb-2">Positions</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Product</th>
                <th className="text-right">Position</th>
                <th className="text-right">Avg Buy</th>
                <th className="text-right">Avg Sell</th>
                <th className="text-right">Buy Vol</th>
                <th className="text-right">Sell Vol</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((mk) => {
                const s = summ[mk.symbol] || { position: 0, avgBuy: 0, avgSell: 0, buyVol: 0, sellVol: 0 };
                return (
                  <tr key={mk.symbol} className="border-b border-zinc-800">
                    <td>{mk.symbol}</td>
                    <td className="text-right">{s.position}</td>
                    <td className="text-right">{s.avgBuy ? s.avgBuy.toFixed(2) : "-"}</td>
                    <td className="text-right">{s.avgSell ? s.avgSell.toFixed(2) : "-"}</td>
                    <td className="text-right">{s.buyVol}</td>
                    <td className="text-right">{s.sellVol}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Trades feed */}
      <section className="border border-zinc-800 rounded-lg p-4">
        <h2 className="font-semibold mb-2">Trades</h2>
        <div className="max-h-[30vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Time (UK)</th>
                <th className="text-left">Product</th>
                <th className="text-right">Price</th>
                <th className="text-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {tape.map((t, i) => (
                <tr key={i} className="border-b border-zinc-800">
                  <td>{fmtTimeUK(t.ts)}</td>
                  <td>{t.symbol}</td>
                  <td className="text-right">{toFixed2(t.price)}</td>
                  <td className="text-right">{t.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Events */}
      <section className="border border-zinc-800 rounded-lg p-4">
        <h2 className="font-semibold mb-2">Events</h2>
        {isAdmin && (
          <div className="flex gap-2 mb-3">
            <input id="evt" className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-2" placeholder="Broadcast an event…" />
            <button
              className="bg-blue-600 rounded px-3 py-2"
              onClick={() => {
                const el = document.getElementById("evt") as HTMLInputElement | null;
                const msg = el?.value?.trim() || "";
                if (msg) {
                  sendEvent(msg);
                  if (el) el.value = "";
                }
              }}
            >
              Send
            </button>
          </div>
        )}
        <div className="max-h-[30vh] overflow-y-auto space-y-1 text-sm">
          {events
            .slice()
            .reverse()
            .map((e, i) => (
              <div key={i} className="text-zinc-300">
                <span className="text-zinc-500">{fmtTimeUK(e.ts)} — </span>
                {e.text}
              </div>
            ))}
        </div>
      </section>
    </main>
  );
}

/* ---------- ticket subcomponent ---------- */

function Ticket({
  symbol,
  tick,
  posLimit,
  onSubmit,
}: {
  symbol: string;
  tick: number;
  posLimit: number;
  onSubmit: (side: "buy" | "sell", price: number, qty: number) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [price, setPrice] = useState<string>("");
  const [qty, setQty] = useState<string>("");

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <div className="flex gap-1">
        <button
          className={"px-3 py-1 rounded border " + (side === "buy" ? "bg-green-700 border-green-600" : "border-zinc-700")}
          onClick={() => setSide("buy")}
        >
          B
        </button>
        <button
          className={"px-3 py-1 rounded border " + (side === "sell" ? "bg-red-700 border-red-600" : "border-zinc-700")}
          onClick={() => setSide("sell")}
        >
          S
        </button>
      </div>
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder={`Price (tick ${tick})`}
        className="bg-transparent border border-zinc-700 rounded px-2 py-1 w-40"
        inputMode="decimal"
      />
      <input
        value={qty}
        onChange={(e) => setQty(e.target.value)}
        placeholder="Qty"
        className="bg-transparent border border-zinc-700 rounded px-2 py-1 w-28"
        inputMode="numeric"
      />
      <button
        title="Place"
        className="px-3 py-1 rounded bg-blue-600"
        onClick={() => {
          const p = Number(price);
          const q = Math.floor(Number(qty));
          if (!(p > 0 && q > 0)) return alert("Enter positive price and quantity.");
          if (!isTickAligned(p, tick)) return alert(`Price must be in multiples of ${tick}.`);
          onSubmit(side, p, q);
          setPrice("");
          setQty("");
        }}
      >
        ✓ Place
      </button>
      <span className="text-xs text-zinc-500">Pos limit: {posLimit}</span>
    </div>
  );
}
