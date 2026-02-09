/* * PROJECT: MMFR LANE 2 - THE ULTIMATE ARCHITECT (v3.7.2)
 * REVISIONS: All-in Exit (TP/SL), Dynamic actualRisk, Rolling ATR Update, 
 * Dashboard Independent Timer (Fixed), Win-rate Optimized RR
 */

/**
 * ⚠️ For educational and research purposes only.
 * Not financial advice. Use at your own risk.
 */


const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });


const IS_TESTNET = process.env.IS_TESTNET === 'true';
const BASE_URL = IS_TESTNET ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
const WS_URL = IS_TESTNET ? 'wss://fstream.binancefuture.com/ws' : 'wss://fstream.binance.com/ws';
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

const api = axios.create({ baseURL: BASE_URL, headers: { 'X-MBX-APIKEY': API_KEY } });

function getSignature(queryString) {
    return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}


const CONFIG = {
    symbol: 'BTCUSDT',
    leverage: 5,
    riskPerR: 0.005, 
    basicRR: 1.5, midRR: 2.0, convictionRR: 2.5,
    slAtrMult: 1.2,
    maxConsecutiveLoss: 4, 
    maxMDD: 6.0,
    dailyLossLimitR: 3, 
    minScore: 8,
    tradeCooldown: 60000,
    tgToken: process.env.TG_TOKEN,
    tgChatId: process.env.TG_CHAT_ID
};

const State = {
    price: 0, prevPrice: 0, candles: [], atr: 0,
    vwap: { value: 0, prevValue: 0, cumPv: 0, cumVol: 0, lastDay: null },
    oi: { current: 0, prev: 0, zScore: 0, history: [], delta: 0 },
    flow: { buy: 0, sell: 0 },
    fundingRate: 0,
    position: null,
    isShutdown: false,
    dailyLossR: 0,
    lastResetDate: new Date().toISOString().slice(0, 10),
    lastTradeTime: 0,
    wsRetryCount: 0,
    exchangeSpecs: { stepSize: 0.001, tickSize: 0.1 },
    performance: { currentBalance: 0, maxBalance: 0, mdd: 0, consecutiveLoss: 0 },
    scores: { l: 0, s: 0, total: 0, side: '', regime: 'RANGE' } // 실시간 점수 저장용
};

let ws;
let oiInterval, flowInterval, syncInterval, atrInterval, dashboardInterval;



function cleanup() {
    if (ws) { try { ws.terminate(); } catch(e){} ws = null; }
    clearInterval(oiInterval);
    clearInterval(flowInterval);
    clearInterval(syncInterval);
    clearInterval(atrInterval);
    clearInterval(dashboardInterval);
    console.log("🧹 Cleanup: All resources cleared.");
}

async function signedRequest(method, endpoint, params = {}) {
    const timestamp = Date.now();
    const queryString = new URLSearchParams({ ...params, timestamp }).toString();
    const signature = getSignature(queryString);
    return api[method.toLowerCase()](`${endpoint}?${queryString}&signature=${signature}`);
}

async function syncBalance() {
    try {
        const res = await signedRequest('GET', '/fapi/v2/account');
        State.performance.currentBalance = parseFloat(res.data.totalWalletBalance);
        State.performance.maxBalance = Math.max(State.performance.maxBalance || 0, State.performance.currentBalance);
        if (State.performance.maxBalance > 0) {
            State.performance.mdd = ((State.performance.maxBalance - State.performance.currentBalance) / State.performance.maxBalance) * 100;
        }
    } catch (e) { }
}

async function updateATR() { 
    try {
        const klines = await api.get(`/fapi/v1/klines?symbol=${CONFIG.symbol}&interval=1m&limit=100`);
        State.candles = klines.data.map(k => ({ h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]) }));
        State.atr = (trs => trs.slice(-14).reduce((a,b)=>a+b)/14)(State.candles.map((c,i,a) => i===0?0:Math.max(c.h-c.l, Math.abs(c.h-a[i-1].c), Math.abs(c.l-a[i-1].c))));
    } catch (e) { }
}

function saveLog(type, data) {
    const logEntry = { type, timestamp: new Date().toISOString(), ...data };
    fs.appendFileSync('./trade_logs.jsonl', JSON.stringify(logEntry) + '\n');
}

async function sendTelegram(msg) {
    if (!CONFIG.tgToken) return;
    try { await axios.post(`https://api.telegram.org/bot${CONFIG.tgToken}/sendMessage`, { chat_id: CONFIG.tgChatId, text: `${IS_TESTNET ? "⚠️[TEST]" : "🚀[REAL]"} ${msg}`, parse_mode: 'Markdown' }); } catch (e) {}
}



async function syncPositionWithExchange() {
    if (!State.position) return;
    try {
        const res = await signedRequest('GET', '/fapi/v2/positionRisk', { symbol: CONFIG.symbol });
        const pos = res.data.find(p => p.symbol === CONFIG.symbol);
        
        if (Math.abs(parseFloat(pos.positionAmt)) < 1e-6) {
            const trades = await signedRequest('GET', '/fapi/v1/userTrades', { symbol: CONFIG.symbol, limit: 15 });
            const relevantTrades = trades.data.filter(t => 
                t.symbol === CONFIG.symbol && parseInt(t.time) >= State.position.startTime && Math.abs(parseFloat(t.qty)) > 0
            );

            const pnlUSDT = relevantTrades.reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
            const pnlR = pnlUSDT / State.position.metrics.actualRisk;

            await syncBalance();
            if (pnlR < 0) { State.dailyLossR += Math.abs(pnlR); State.performance.consecutiveLoss++; } 
            else { State.performance.consecutiveLoss = 0; }

            try { await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: CONFIG.symbol }); } catch (e) {}
            saveLog('EXIT', { ...State.position, pnlUSDT, pnlR, reason: pnlR > 0 ? 'TP' : 'SL', finalBalance: State.performance.currentBalance });
            sendTelegram(`🔴 *EXIT CONFIRMED*\nPnL: ${pnlR.toFixed(2)}R\nDaily Loss: ${State.dailyLossR.toFixed(2)}R\nBal: $${State.performance.currentBalance.toFixed(2)}`);
            State.position = null;
        }
    } catch (e) { }
}

async function executeTrade(side, rr, score, metrics) {
    if (State.position || State.isShutdown) return;
    const riskAmount = State.performance.currentBalance * CONFIG.riskPerR;
    const slDistRaw = State.atr * CONFIG.slAtrMult;
    let qty = Math.floor((riskAmount / slDistRaw) / State.exchangeSpecs.stepSize) * State.exchangeSpecs.stepSize;
    if (qty <= 0) return;

    try {
        const res = await signedRequest('POST', '/fapi/v1/order', { symbol: CONFIG.symbol, side, type: 'MARKET', quantity: qty });
        if (res.data.status === 'FILLED') {
            State.lastTradeTime = Date.now();
            const entryPrice = parseFloat(res.data.avgPrice);
            const slPrice = Math.round((side === 'BUY' ? entryPrice - slDistRaw : entryPrice + slDistRaw) / State.exchangeSpecs.tickSize) * State.exchangeSpecs.tickSize;
            const tpPrice = Math.round((side === 'BUY' ? entryPrice + (slDistRaw * rr) : entryPrice - (slDistRaw * rr)) / State.exchangeSpecs.tickSize) * State.exchangeSpecs.tickSize;

            await signedRequest('POST', '/fapi/v1/order', { symbol: CONFIG.symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true', reduceOnly: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });
            await signedRequest('POST', '/fapi/v1/order', { symbol: CONFIG.symbol, side: side === 'BUY' ? 'SELL' : 'BUY', type: 'TAKE_PROFIT_MARKET', stopPrice: tpPrice, closePosition: 'true', reduceOnly: 'true', workingType: 'MARK_PRICE', priceProtect: 'true' });

            const actualSlDist = Math.abs(entryPrice - slPrice);
            State.position = { side, entryPrice, qty, startTime: Date.now(), metrics: { ...metrics, actualRisk: actualSlDist * qty }, score };
            saveLog('ENTRY', { side, score, rr, entryPrice, qty, ...metrics });
            sendTelegram(`🟢 *ENTRY ${side}*\nScore: ${score} | RR: 1:${rr}\nRegime: ${metrics.regime}`);
        }
    } catch (e) { console.error("❌ Order Execution Fail", e.response?.data || e.message); }
}



function runStrategy() {
    const todayISO = new Date().toISOString().slice(0, 10);
    if (State.lastResetDate !== todayISO) {
        State.dailyLossR = 0; State.lastResetDate = todayISO;
        if (State.isShutdown && State.performance.mdd < CONFIG.maxMDD) State.isShutdown = false;
    }

    if (State.performance.mdd >= CONFIG.maxMDD || State.performance.consecutiveLoss >= CONFIG.maxConsecutiveLoss || State.dailyLossR >= CONFIG.dailyLossLimitR) {
        if (!State.isShutdown) { State.isShutdown = true; sendTelegram("🛑 SYSTEM HALTED: Risk Limit Reached"); }
        return;
    }

    if (State.price === 0 || State.oi.history.length < 30) return;

    const atrPct = State.atr / State.price;
    const priceDeltaRaw = State.price - State.prevPrice;
    const flowRatio = State.flow.buy / (State.flow.sell || 1);
    const vwapSlope = (State.vwap.value - State.vwap.prevValue) / State.price;
    const isTrend = Math.abs(vwapSlope) > 0.00015;

    let oiScore = 0;
    if (State.oi.delta > 0) {
        if (priceDeltaRaw > 0) oiScore = 1; else if (priceDeltaRaw < 0) oiScore = -1;
    }

    const fundingBiasRaw = Math.abs(State.fundingRate) / 0.0015;
    const fundingBias = Math.sign(-State.fundingRate) * Math.min(1.5, fundingBiasRaw);

    let lScore = 0; let sScore = 0; let f = 0;
    if (Math.abs(State.price - State.vwap.value) / State.vwap.value > 0.001) {
        if (State.price > State.vwap.value) lScore += 3; else sScore += 3; f++;
    }
    if (Math.abs(priceDeltaRaw / State.price) > 0.0002) {
        if (priceDeltaRaw > 0) lScore += 2; else sScore += 2; f++;
    }
    if (flowRatio > 1.8) { lScore += 2; f++; } else if (flowRatio < 0.5) { sScore += 2; f++; }

    lScore += (fundingBias + (oiScore > 0 ? 1 : 0)); 
    sScore += (-fundingBias + (oiScore < 0 ? 1 : 0));

    State.scores = { l: lScore, s: sScore, total: Math.max(lScore, sScore), side: lScore > sScore ? 'BUY' : 'SELL', regime: isTrend ? 'TREND' : 'RANGE' };

    if (!State.position && Date.now() - State.lastTradeTime >= CONFIG.tradeCooldown) {
        if (isTrend || State.scores.total >= 9) {
            if (State.scores.total >= CONFIG.minScore && f >= 3) {
                let rr = isTrend ? CONFIG.convictionRR : CONFIG.basicRR;
                if (State.scores.total >= 10) rr += 0.5;
                executeTrade(State.scores.side, rr, State.scores.total, { atrPct, funding: State.fundingRate, oiZ: State.oi.zScore, flow: flowRatio, regime: State.scores.regime, fundingBias });
            }
        }
    }
}

function renderDashboard() {
    process.stdout.write('\x1Bc'); 
    console.log(`[ MMFR LANE 2 - v3.7.2 ELITE ] - ${new Date().toLocaleTimeString()}`);
    console.log(`- Status: ${State.oi.history.length < 30 ? '🟡 Warming Up...' : '🟢 Live Monitoring'}`);
    console.log(`- Progress: [${State.oi.history.length}/30] Data Points`);
    console.log(`---------------------------------`);
    console.log(`- Price: ${State.price.toFixed(1)} | ATR: ${State.atr.toFixed(2)} (${((State.atr/State.price)*100).toFixed(3)}%)`);
    console.log(`- OI Z-Score: ${State.oi.zScore.toFixed(2)} | Delta: ${State.oi.delta > 0 ? '↑' : '↓'}`);
    console.log(`- Score: (L:${State.scores.l.toFixed(1)} / S:${State.scores.s.toFixed(1)}) | Regime: ${State.scores.regime}`);
    console.log(`- Balance: $${State.performance.currentBalance.toFixed(2)} | Daily Loss: ${State.dailyLossR.toFixed(2)}R`);
    console.log(`---------------------------------`);
    if (State.position) {
        console.log(`🚀 ACTIVE POSITION: ${State.position.side} | Entry: ${State.position.entryPrice}`);
    }
}



async function init() {
    cleanup();
    console.log(`🛠️ v3.7.2 Elite Booting...`);
    try {
        await syncBalance();
        await updateATR();
        await signedRequest('POST', '/fapi/v1/leverage', { symbol: CONFIG.symbol, leverage: CONFIG.leverage });
        
        const info = await api.get('/fapi/v1/exchangeInfo');
        const s = info.data.symbols.find(x => x.symbol === CONFIG.symbol);
        State.exchangeSpecs = { stepSize: parseFloat(s.filters.find(f=>f.filterType==='LOT_SIZE').stepSize), tickSize: parseFloat(s.filters.find(f=>f.filterType==='PRICE_FILTER').tickSize) };

        ws = new WebSocket(WS_URL);
        ws.on('open', () => {
            ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${CONFIG.symbol.toLowerCase()}@aggTrade`, `${CONFIG.symbol.toLowerCase()}@markPrice`], id: 1 }));
            console.log("📡 WebSocket Online. Dashboard starting in 5s...");
            sendTelegram("✅ MMFR v3.7.2 엔진 가동 (TEST_DRIVE)");
            
            // 🔴 5초 뒤 대시보드 루프 시작
            setTimeout(() => {
                dashboardInterval = setInterval(renderDashboard, 10000);
            }, 5000);
        });

        ws.on('message', (d) => {
            const m = JSON.parse(d);
            if (m.e === 'aggTrade') {
                const p = parseFloat(m.p); const v = parseFloat(m.q);
                if (State.price === 0) { State.price = p; State.prevPrice = p; return; }
                if (new Date(m.T).getUTCDate() !== State.vwap.lastDay) { State.vwap.cumPv = 0; State.vwap.cumVol = 0; State.vwap.lastDay = new Date(m.T).getUTCDate(); }
                State.vwap.prevValue = State.vwap.value;
                State.vwap.cumPv += p * v; State.vwap.cumVol += v; State.vwap.value = State.vwap.cumPv / State.vwap.cumVol;
                if (m.m) State.flow.sell += v; else State.flow.buy += v;
                State.prevPrice = State.price; State.price = p; runStrategy();
            } else if (m.e === 'markPrice') { State.fundingRate = parseFloat(m.r); }
        });

        ws.on('close', () => setTimeout(init, 5000));
        ws.on('error', () => ws.terminate());

        flowInterval = setInterval(() => { State.flow.buy = 0; State.flow.sell = 0; }, 60000);
        atrInterval = setInterval(updateATR, 60000); 
        oiInterval = setInterval(async () => {
            try {
                const oi = await api.get(`/fapi/v1/openInterest?symbol=${CONFIG.symbol}`);
                const currentOI = parseFloat(oi.data.openInterest);
                State.oi.delta = currentOI - (State.oi.current || currentOI);
                State.oi.prev = State.oi.current; State.oi.current = currentOI;
                State.oi.history.push(State.oi.current); if (State.oi.history.length > 60) State.oi.history.shift();
                if (State.oi.history.length >= 30) {
                    const avg = State.oi.history.reduce((a,b)=>a+b)/State.oi.history.length;
                    const std = Math.sqrt(State.oi.history.map(x=>Math.pow(x-avg,2)).reduce((a,b)=>a+b)/State.oi.history.length);
                    State.oi.zScore = std === 0 ? 0 : (State.oi.current - avg) / std;
                }
            } catch (e) { }
        }, 60000);
        syncInterval = setInterval(syncPositionWithExchange, 10000);

    } catch (e) { console.error("❌ Init Error", e.message); setTimeout(init, 10000); }
}

init();
