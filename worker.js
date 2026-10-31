/**
 * Texas Hold'em - Cloudflare Worker + Durable Object
 * ---------------------------------------------------
 * שרת פוקר טקסס הולדם מולטיפלייר בזמן אמת, מבוסס WebSockets ו-Durable Objects.
 * כל השחקנים מתחברים לאותו שולחן (Durable Object בודד בשם "main-table").
 *
 * הערות עיצוביות (לפשטות):
 * - אין "side pots" (קופות צד) מלאות — יש קופה אחת בלבד. אם שחקן הולך All-In
 *   עם פחות צ'יפים מהאחרים, הוא עדיין מתחרה על כל הקופה (לא מדויק 100% מול
 *   כללי טורניר רשמיים, אך זה מספיק עבור משחק בסיסי).
 * - מצב המשחק נשמר בזיכרון של ה-Durable Object בלבד (לא ב-storage), כך
 *   שאיפוס/פינוי של ה-Durable Object ינקה את המשחק. זה בסדר להדגמה פשוטה.
 */

// ---------------------------------------------------------------------------
// עזרי קלפים
// ---------------------------------------------------------------------------

function createDeck() {
  const suits = ["h", "d", "c", "s"];
  const ranks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) {
      deck.push({ rank: r, suit: s });
    }
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

// ---------------------------------------------------------------------------
// הערכת ידי פוקר (7 קלפים -> הכי טובה מתוך 5)
// קטגוריות: 8=סטרייט פלאש, 7=רביעיה, 6=פול האוס, 5=פלאש, 4=סטרייט,
//            3=שלישיה, 2=שני זוגות, 1=זוג, 0=קלף גבוה
// ---------------------------------------------------------------------------

function handCategoryName(cat) {
  const names = [
    "קלף גבוה",
    "זוג",
    "שני זוגות",
    "שלישיה",
    "סטרייט",
    "פלאש",
    "פול האוס",
    "רביעיה",
    "סטרייט פלאש",
  ];
  return names[cat] || "";
}

function combinations(arr, k) {
  const result = [];
  function helper(start, combo) {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return result;
}

function evaluate5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniqueRanks = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) {
      isStraight = true;
      straightHigh = uniqueRanks[0];
    } else if (uniqueRanks.join(",") === "14,5,4,3,2") {
      // "wheel": A-2-3-4-5
      isStraight = true;
      straightHigh = 5;
    }
  }

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  if (isStraight && isFlush) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].rank, groups[1].rank];
  if (groups[0].count === 3 && groups[1].count === 2)
    return [6, groups[0].rank, groups[1].rank];
  if (isFlush) return [5, ...ranks];
  if (isStraight) return [4, straightHigh];
  if (groups[0].count === 3)
    return [3, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
    return [2, pairRanks[0], pairRanks[1], groups[2].rank];
  }
  if (groups[0].count === 2)
    return [1, groups[0].rank, ...groups.slice(1).map((g) => g.rank)];
  return [0, ...ranks];
}

function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function evaluate7(cards) {
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!best || compareScores(score, best) > 0) best = score;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Durable Object - שולחן הפוקר
// ---------------------------------------------------------------------------

export class PokerTable {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = []; // [{ ws, playerId }]
    this.game = this.createInitialGame();
  }

  createInitialGame() {
    return {
      players: [],
      communityCards: [],
      deck: [],
      pot: 0,
      currentBet: 0,
      minRaise: 20,
      bigBlind: 20,
      smallBlind: 10,
      dealerIndex: -1,
      turnIndex: -1,
      phase: "waiting", // waiting | preflop | flop | turn | river | ended
      log: [],
      lastWinners: null,
      showdownReveal: null,
    };
  }

  // --- HTTP / WebSocket entry point ----------------------------------------

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.handleSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    const session = { ws, playerId: null };
    this.sessions.push(session);

    ws.addEventListener("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch (e) {
        return;
      }
      this.handleMessage(session, data);
    });

    const cleanup = () => this.handleDisconnect(session);
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  handleDisconnect(session) {
    const g = this.game;
    const idx = g.players.findIndex((p) => p.id === session.playerId);
    if (idx !== -1) {
      g.players[idx].connected = false;
      const activeHand = g.phase !== "waiting" && g.phase !== "ended";
      if (activeHand && g.turnIndex === idx && !g.players[idx].folded) {
        g.players[idx].folded = true;
        this.addLog(`${g.players[idx].name} התנתק וזרק קלפים אוטומטית`);
        this.advanceTurn(idx);
      }
    }
    this.sessions = this.sessions.filter((s) => s !== session);
    this.broadcastState();
  }

  handleMessage(session, data) {
    try {
      switch (data.type) {
        case "join":
          this.onJoin(session, data);
          break;
        case "start":
          this.onStart();
          break;
        case "action":
          this.onAction(session, data);
          break;
        default:
          break;
      }
    } catch (err) {
      this.sendTo(session, { type: "error", message: String(err.message || err) });
    }
    this.broadcastState();
  }

  // --- פעולות שחקן -----------------------------------------------------------

  onJoin(session, data) {
    const name = String(data.name || "שחקן").slice(0, 20) || "שחקן";
    const requestedId = data.playerId;
    let player = requestedId
      ? this.game.players.find((p) => p.id === requestedId)
      : null;

    if (player) {
      player.connected = true;
      player.name = name;
      session.playerId = player.id;
    } else {
      if (this.game.players.length >= 8) {
        this.sendTo(session, {
          type: "error",
          message: "השולחן מלא (מקסימום 8 שחקנים)",
        });
        return;
      }
      const handInProgress =
        this.game.phase !== "waiting" && this.game.phase !== "ended";
      const id = crypto.randomUUID();
      player = {
        id,
        name,
        chips: 1000,
        holeCards: [],
        folded: handInProgress, // מצטרף באמצע יד - יושב בחוץ עד היד הבאה
        allIn: false,
        bet: 0,
        hasActed: false,
        connected: true,
      };
      this.game.players.push(player);
      session.playerId = id;
    }

    this.sendTo(session, { type: "joined", playerId: player.id });
  }

  onStart() {
    const g = this.game;
    if (g.phase !== "waiting" && g.phase !== "ended") {
      throw new Error("יד כבר מתקיימת כרגע");
    }
    const eligible = g.players.filter((p) => p.chips > 0);
    if (eligible.length < 2) {
      throw new Error("צריך לפחות 2 שחקנים עם צ'יפים כדי להתחיל יד");
    }
    this.startHand();
  }

  onAction(session, data) {
    const g = this.game;
    const playerIndex = g.players.findIndex((p) => p.id === session.playerId);
    if (playerIndex === -1) throw new Error("שחקן לא נמצא, התחבר מחדש");
    if (g.phase === "waiting" || g.phase === "ended")
      throw new Error("אין יד פעילה כרגע");
    if (g.turnIndex !== playerIndex) throw new Error("לא תורך לפעול");

    const player = g.players[playerIndex];
    const toCall = g.currentBet - player.bet;
    const action = data.action;

    if (action === "fold") {
      player.folded = true;
      this.addLog(`${player.name} פרש (Fold)`);
    } else if (action === "check") {
      if (toCall > 0) throw new Error("אי אפשר לעשות Check, יש הימור לכסות");
      this.addLog(`${player.name} עשה Check`);
    } else if (action === "call") {
      if (toCall <= 0) throw new Error("אין מה לקרוא, אפשר לעשות Check");
      const amount = Math.min(toCall, player.chips);
      this.postBet(player, amount);
      this.addLog(
        `${player.name} עשה Call${player.allIn ? " (All-In)" : ""} של ${amount}`
      );
    } else if (action === "raise") {
      const raiseTo = Number(data.amount);
      if (!Number.isFinite(raiseTo)) throw new Error("סכום העלאה לא תקין");
      const additionalNeeded = raiseTo - player.bet;
      if (additionalNeeded <= 0) throw new Error("סכום ההעלאה לא תקין");
      if (additionalNeeded > player.chips)
        throw new Error("אין לך מספיק צ'יפים להעלאה הזו");
      if (raiseTo <= g.currentBet)
        throw new Error("ההעלאה חייבת להיות גבוהה מההימור הנוכחי");
      const isAllIn = additionalNeeded === player.chips;
      const minRaiseTo = g.currentBet + g.minRaise;
      if (!isAllIn && raiseTo < minRaiseTo) {
        throw new Error(`ההעלאה המינימלית היא ל-${minRaiseTo}`);
      }
      const prevBet = g.currentBet;
      this.postBet(player, additionalNeeded);
      g.currentBet = player.bet;
      g.minRaise = Math.max(g.minRaise, g.currentBet - prevBet);
      g.players.forEach((p, i) => {
        if (i !== playerIndex && !p.folded && !p.allIn) p.hasActed = false;
      });
      this.addLog(
        `${player.name} העלה ל-${g.currentBet}${isAllIn ? " (All-In)" : ""}`
      );
    } else {
      throw new Error("פעולה לא מוכרת");
    }

    player.hasActed = true;
    this.advanceTurn(playerIndex);
  }

  // --- לוגיקת משחק -----------------------------------------------------------

  postBet(player, amount) {
    const actual = Math.min(amount, player.chips);
    player.chips -= actual;
    player.bet += actual;
    this.game.pot += actual;
    if (player.chips === 0) player.allIn = true;
    return actual;
  }

  nextActiveIndex(fromIndex) {
    const g = this.game;
    const n = g.players.length;
    if (n === 0) return -1;
    let i = fromIndex;
    for (let count = 0; count < n; count++) {
      i = (i + 1) % n;
      if (!g.players[i].folded) return i;
    }
    return -1;
  }

  nextToAct(fromIndex) {
    const g = this.game;
    const n = g.players.length;
    if (n === 0) return -1;
    let i = fromIndex;
    for (let count = 0; count < n; count++) {
      i = (i + 1) % n;
      const p = g.players[i];
      if (!p.folded && !p.allIn && p.chips > 0) return i;
    }
    return -1;
  }

  activeOrderFrom(startIndex) {
    const g = this.game;
    const n = g.players.length;
    const order = [];
    for (let k = 0; k < n; k++) {
      const idx = (startIndex + k) % n;
      const p = g.players[idx];
      if (!p.folded) order.push(p);
    }
    return order;
  }

  startHand() {
    const g = this.game;

    g.players.forEach((p) => {
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.bet = 0;
      p.hasActed = false;
      p.holeCards = [];
    });

    g.communityCards = [];
    g.pot = 0;
    g.currentBet = 0;
    g.deck = shuffle(createDeck());
    g.phase = "preflop";
    g.log = [];
    g.lastWinners = null;
    g.showdownReveal = null;

    g.dealerIndex = this.nextActiveIndex(g.dealerIndex);

    const dealOrder = this.activeOrderFrom(g.dealerIndex + 1);
    for (let round = 0; round < 2; round++) {
      for (const p of dealOrder) {
        p.holeCards.push(g.deck.pop());
      }
    }

    const activeCount = g.players.filter((p) => !p.folded).length;
    let sbIndex, bbIndex;
    if (activeCount === 2) {
      // הד-אפ: הדילר מניח את ה-Small Blind
      sbIndex = g.dealerIndex;
      bbIndex = this.nextActiveIndex(g.dealerIndex);
    } else {
      sbIndex = this.nextActiveIndex(g.dealerIndex);
      bbIndex = this.nextActiveIndex(sbIndex);
    }

    this.postBet(g.players[sbIndex], g.smallBlind);
    this.postBet(g.players[bbIndex], g.bigBlind);
    g.currentBet = g.bigBlind;
    g.minRaise = g.bigBlind;

    g.turnIndex = this.nextToAct(bbIndex);

    this.addLog(`--- יד חדשה --- דילר: ${g.players[g.dealerIndex].name}`);
    this.addLog(
      `${g.players[sbIndex].name} הניח Small Blind (${g.smallBlind}), ${g.players[bbIndex].name} הניח Big Blind (${g.bigBlind})`
    );
  }

  advanceTurn(fromIndex) {
    const g = this.game;
    const remaining = g.players.filter((p) => !p.folded);

    if (remaining.length === 1) {
      this.endHandBySingleWinner(remaining[0]);
      return;
    }

    const canAct = g.players.filter((p) => !p.folded && !p.allIn);
    const roundComplete =
      canAct.length === 0 ||
      canAct.every((p) => p.hasActed && p.bet === g.currentBet);

    if (roundComplete) {
      this.advancePhase();
    } else {
      const next = this.nextToAct(fromIndex);
      if (next === -1) {
        this.advancePhase();
      } else {
        g.turnIndex = next;
      }
    }
  }

  advancePhase() {
    const g = this.game;
    g.players.forEach((p) => {
      p.bet = 0;
      p.hasActed = false;
    });
    g.currentBet = 0;
    g.minRaise = g.bigBlind;

    if (g.phase === "preflop") {
      g.deck.pop(); // שריפת קלף
      g.communityCards.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
      g.phase = "flop";
      this.addLog("--- Flop ---");
    } else if (g.phase === "flop") {
      g.deck.pop();
      g.communityCards.push(g.deck.pop());
      g.phase = "turn";
      this.addLog("--- Turn ---");
    } else if (g.phase === "turn") {
      g.deck.pop();
      g.communityCards.push(g.deck.pop());
      g.phase = "river";
      this.addLog("--- River ---");
    } else if (g.phase === "river") {
      this.showdown();
      return;
    }

    const canAct = g.players.filter((p) => !p.folded && !p.allIn);
    if (canAct.length <= 1) {
      // כולם (או כמעט כולם) All-In - ממשיכים לחלק את שאר הקלפים אוטומטית
      this.advancePhase();
      return;
    }

    const next = this.nextToAct(g.dealerIndex);
    g.turnIndex = next;
  }

  endHandBySingleWinner(winner) {
    const g = this.game;
    const amount = g.pot;
    winner.chips += amount;
    g.pot = 0;
    g.phase = "ended";
    g.turnIndex = -1;
    g.lastWinners = [{ id: winner.id, name: winner.name, amount, hand: null }];
    this.addLog(`${winner.name} זכה בקופה של ${amount} (כל היריבים פרשו)`);
  }

  showdown() {
    const g = this.game;
    const contenders = g.players.filter((p) => !p.folded);
    const results = contenders.map((p) => {
      const score = evaluate7([...p.holeCards, ...g.communityCards]);
      return { player: p, score, handName: handCategoryName(score[0]) };
    });

    let best = null;
    for (const r of results) {
      if (!best || compareScores(r.score, best) > 0) best = r.score;
    }
    const winners = results.filter((r) => compareScores(r.score, best) === 0);

    const amountEach = Math.floor(g.pot / winners.length);
    const remainder = g.pot - amountEach * winners.length;
    winners.forEach((w, idx) => {
      const amt = amountEach + (idx < remainder ? 1 : 0);
      w.player.chips += amt;
    });

    g.lastWinners = winners.map((w) => ({
      id: w.player.id,
      name: w.player.name,
      amount: amountEach,
      hand: w.handName,
    }));
    g.showdownReveal = results.map((r) => ({
      id: r.player.id,
      name: r.player.name,
      holeCards: r.player.holeCards,
      hand: r.handName,
    }));

    this.addLog(
      `Showdown: ${winners
        .map((w) => `${w.player.name} (${w.handName})`)
        .join(", ")} זכו בקופה של ${g.pot}`
    );

    g.pot = 0;
    g.phase = "ended";
    g.turnIndex = -1;
  }

  addLog(message) {
    this.game.log.push(message);
    if (this.game.log.length > 60) this.game.log.shift();
  }

  // --- שידור מצב ללקוחות -----------------------------------------------------

  sendTo(session, obj) {
    try {
      session.ws.send(JSON.stringify(obj));
    } catch (e) {
      // ws כנראה סגור - יתנקה בקריאת close/error
    }
  }

  broadcastState() {
    for (const session of this.sessions) {
      this.sendTo(session, {
        type: "state",
        state: this.getViewFor(session.playerId),
      });
    }
  }

  getViewFor(viewerId) {
    const g = this.game;
    const revealMap = {};
    if (g.showdownReveal) {
      for (const r of g.showdownReveal) revealMap[r.id] = true;
    }

    const players = g.players.map((p) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      bet: p.bet,
      connected: p.connected,
      isTurn: g.turnIndex !== -1 && g.players[g.turnIndex]?.id === p.id,
      isDealer: g.dealerIndex !== -1 && g.players[g.dealerIndex]?.id === p.id,
      holeCards:
        p.id === viewerId || revealMap[p.id]
          ? p.holeCards
          : p.holeCards.length
          ? ["back", "back"]
          : [],
    }));

    const me = g.players.find((p) => p.id === viewerId);

    return {
      players,
      communityCards: g.communityCards,
      pot: g.pot,
      currentBet: g.currentBet,
      minRaise: g.minRaise,
      bigBlind: g.bigBlind,
      smallBlind: g.smallBlind,
      phase: g.phase,
      yourId: viewerId || null,
      yourTurn: !!(
        me &&
        g.turnIndex !== -1 &&
        g.players[g.turnIndex]?.id === viewerId
      ),
      toCall: me ? Math.max(0, g.currentBet - me.bet) : 0,
      canStart:
        (g.phase === "waiting" || g.phase === "ended") &&
        g.players.filter((p) => p.chips > 0).length >= 2,
      lastWinners: g.lastWinners,
      log: g.log.slice(-20),
    };
  }
}

// ---------------------------------------------------------------------------
// Worker ראשי - מנתב בקשות ל-Durable Object
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const id = env.POKER_TABLE.idFromName("main-table");
      const stub = env.POKER_TABLE.get(id);
      return stub.fetch(request);
    }

    return new Response(
      "שרת פוקר טקסס הולדם פעיל. התחבר דרך WebSocket בנתיב /ws",
      { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  },
};
