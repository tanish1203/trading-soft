// server/orderbook.js (CommonJS)

class Order {
  constructor({ id, userId, side, price, qty, ts = Date.now() }) {
    this.id = id;
    this.userId = userId;
    this.side = side;          // 'buy' | 'sell'
    this.price = +price;
    this.qty = +qty;
    this.leaves = +qty;
    this.ts = ts;
  }
}

function pushAtPrice(map, price, order) {
  if (!map.has(price)) map.set(price, []);
  map.get(price).push(order); // FIFO
}

function bestBid(mapBids) {
  if (mapBids.size === 0) return null;
  return Math.max(...mapBids.keys());
}
function bestAsk(mapAsks) {
  if (mapAsks.size === 0) return null;
  return Math.min(...mapAsks.keys());
}
function snapToTick(px, tick) {
  const t = Math.max(0.000001, +tick || 0.01);
  return Math.round(px / t) * t;
}

class OrderBook {
  constructor({ symbol, tickSize = 0.1, posLimit = 100, onTrade = null }) {
    this.symbol   = symbol;
    this.tickSize = tickSize;
    this.posLimit = posLimit;
    this.onTrade  = typeof onTrade === "function" ? onTrade : null;

    this.bids = new Map(); // price -> Order[]
    this.asks = new Map();
    this.orderIdSeq = 1;

    this.positions = new Map(); // userId -> { qty, cash }
    this.trades = [];           // {ts, price, qty, buyer, seller}
  }

  static snap(px, tick) { return snapToTick(px, tick); }

  _pos(userId) {
    if (!this.positions.has(userId)) this.positions.set(userId, { qty: 0, cash: 0 });
    return this.positions.get(userId);
  }

  bestBid() { return bestBid(this.bids); }
  bestAsk() { return bestAsk(this.asks); }
  mid() {
    const bb = this.bestBid(), ba = this.bestAsk();
    if (bb != null && ba != null) return (bb + ba) / 2;
    if (bb != null) return bb;
    if (ba != null) return ba;
    return null;
  }

  snapshotFor(userId, depth = 200) {
    const sideSnap = (map, desc) => {
      const prices = [...map.keys()].sort((a,b)=> desc ? b-a : a-b).slice(0, depth);
      return prices.map(p => {
        const orders = map.get(p);
        const size = orders.reduce((s,o)=> s + o.leaves, 0);
        const my   = orders.reduce((s,o)=> s + (o.userId === userId ? o.leaves : 0), 0);
        return { price: p, size, my };
      });
    };
    return { symbol: this.symbol, bids: sideSnap(this.bids, true), asks: sideSnap(this.asks, false) };
  }

  getPosPublic(userId) {
    const { qty, cash } = this._pos(userId);
    return { userId, qty, cash };
  }

  _checkPosLimit(userId, side, incQty) {
    const p = this._pos(userId);
    const newQty = side === 'buy' ? p.qty + incQty : p.qty - incQty;
    return Math.abs(newQty) <= this.posLimit;
  }

  _recordTrade(trade) {
    this.trades.push(trade);
    if (this.trades.length > 1000) this.trades.shift();
    if (this.onTrade) this.onTrade(trade);
  }

  _matchIncoming(order) {
    const makerMap = order.side === 'buy' ? this.asks : this.bids;
    const best = () => order.side === 'buy' ? bestAsk(makerMap) : bestBid(makerMap);

    while (order.leaves > 0 && makerMap.size > 0) {
      const px = best();
      if (px == null) break;
      const cross = (order.side === 'buy' && order.price >= px) ||
                    (order.side === 'sell' && order.price <= px);
      if (!cross) break;

      const q = makerMap.get(px);
      while (order.leaves > 0 && q.length) {
        const maker = q[0];
        const tradeQty = Math.min(order.leaves, maker.leaves);

        if (!this._checkPosLimit(order.userId, order.side, tradeQty)) {
          order.leaves = 0; // stop due to limit
          break;
        }

        order.leaves -= tradeQty;
        maker.leaves -= tradeQty;

        const tradePx = px;
        const buyer  = order.side === 'buy' ? order.userId : maker.userId;
        const seller = order.side === 'sell' ? order.userId : maker.userId;

        this._pos(buyer).qty  += tradeQty;
        this._pos(buyer).cash -= tradeQty * tradePx;
        this._pos(seller).qty -= tradeQty;
        this._pos(seller).cash += tradeQty * tradePx;

        this._recordTrade({ ts: Date.now(), symbol: this.symbol, price: tradePx, qty: tradeQty, buyer, seller });

        if (maker.leaves === 0) q.shift();
      }
      if (q.length === 0) makerMap.delete(px);
    }
  }

  placeLimit({ userId, side, price, qty }) {
    // pre-check against pos limit "in theory"
    if (!this._checkPosLimit(userId, side, qty)) {
      return { rejected: true, reason: "pos_limit" };
    }

    const id = this.orderIdSeq++;
    const order = new Order({ id, userId, side, price: snapToTick(price, this.tickSize), qty });

    this._matchIncoming(order);

    if (order.leaves > 0) {
      const map = side === 'buy' ? this.bids : this.asks;
      pushAtPrice(map, order.price, order);
    }
    return { orderId: id };
  }

  cancelAtPrice({ userId, side, price }) {
    const map = side === 'buy' ? this.bids : this.asks;
    const px = snapToTick(price, this.tickSize);
    if (!map.has(px)) return 0;
    const q = map.get(px);
    const before = q.length;
    const filtered = q.filter(o => o.userId !== userId);
    const removed = before - filtered.length;
    if (filtered.length) map.set(px, filtered); else map.delete(px);
    return removed;
  }

  takeAtPrice({ userId, side, price, maxQty }) {
    const makerMap = side === 'buy' ? this.asks : this.bids;
    const px = snapToTick(price, this.tickSize);
    if (!makerMap.has(px)) return 0;
    const q = makerMap.get(px);
    let remaining = Math.max(0, +maxQty || 0);
    if (!remaining) return 0;

    while (remaining > 0 && q.length) {
      const maker = q[0];
      const tradeQty = Math.min(remaining, maker.leaves);

      if (!this._checkPosLimit(userId, side, tradeQty)) break;

      maker.leaves -= tradeQty;
      remaining -= tradeQty;

      const tradePx = px;
      const buyer  = side === 'buy' ? userId : maker.userId;
      const seller = side === 'sell' ? userId : maker.userId;

      this._pos(buyer).qty  += tradeQty;
      this._pos(buyer).cash -= tradeQty * tradePx;
      this._pos(seller).qty -= tradeQty;
      this._pos(seller).cash += tradeQty * tradePx;

      this._recordTrade({ ts: Date.now(), symbol: this.symbol, price: tradePx, qty: tradeQty, buyer, seller });

      if (maker.leaves === 0) q.shift();
    }
    if (!q.length) makerMap.delete(px);
    return true;
  }
}

module.exports = OrderBook;
