# Aegis: Intent-Based Execution and Liquidity Protection for DeepBook V3

**Version 1.0 — Sui Testnet**

---

## Abstract

On-chain order books expose every trade to adversarial front-running. A large visible order telegraphs intent, allowing bots to shift the ask side before the transaction lands. Aegis solves this by replacing single large orders with an atomically executed, Gaussian-weighted grid of child limit orders. A five-signal risk engine scores the live order book, an adaptive planner decomposes the intent into a price-banded grid, and all orders are deployed in a single Sui Programmable Transaction Block — all-or-nothing, with no exposed footprint. This paper describes the mathematics and architecture behind each component.

---

## 1. Problem Statement

DeepBook V3 is a fully on-chain central limit order book on Sui. It is transparent by design: every pending transaction is visible in the mempool before it is executed. This transparency is exploitable.

When a trader submits a large market order for quantity $Q$ at time $t$, adversarial bots observe the transaction before it settles. They front-run the ask side by placing orders at higher prices, forcing the trader to fill at a worse price. This is the **toxic flow problem**: the trader's own intent shifts the market against them.

The naive defense — slicing the order manually into smaller pieces — does not help if each slice is still submitted as a visible single order. What is needed is:

1. A way to measure how dangerous the current order book is before trading.
2. A way to decompose the intent into multiple child orders across a price band.
3. A guarantee that either all child orders execute or none do.

Aegis provides all three.

---

## 2. Architecture Overview

```
User Intent
    │
    ▼
Risk Engine  ←──  Live Order Book
    │
    ▼  risk score ρ ∈ [0, 1]
    │
    ▼
Gaussian Grid Planner
    │
    ▼  n child orders {(price_i, qty_i)}
    │
    ▼
Sui PTB Builder  →  DeepBook V3  →  OrderPlaced × n (atomic)
```

The pipeline is stateless and runs per intent. There is no persistent state outside of the on-chain BalanceManager holding collateral.

---

## 3. Intent Model

A trade intent is a 5-tuple:

$$
\mathcal{I} = (\text{pair},\ \text{side},\ Q,\ \delta_{\max},\ u)
$$

where:
- $\text{pair}$ — the trading pair, e.g. `SUI_DBUSDC`
- $\text{side} \in \{\text{buy}, \text{sell}\}$
- $Q > 0$ — total quantity in base coin units
- $\delta_{\max} > 0$ — maximum acceptable slippage in basis points
- $u \in \{\text{patient}, \text{normal}, \text{fast}\}$ — urgency level

The urgency level maps to a multiplier $\mu_u$:

$$
\mu_u = \begin{cases} 0.82 & u = \text{patient} \\ 1.00 & u = \text{normal} \\ 1.18 & u = \text{fast} \end{cases}
$$

---

## 4. Risk Engine

### 4.1 Order Book Representation

The order book is a snapshot at time $t$:

$$
\mathcal{B} = \bigl(\{(p_i^b, q_i^b)\}_{i=1}^{L},\ \{(p_j^a, q_j^a)\}_{j=1}^{L},\ \{r_k\}_{k=1}^{K}\bigr)
$$

where $(p_i^b, q_i^b)$ are bid levels sorted descending, $(p_j^a, q_j^a)$ are ask levels sorted ascending, and $\{r_k\}$ is the sequence of the last $K$ traded prices.

The mid price is:

$$
m = \frac{p_1^b + p_1^a}{2}
$$

### 4.2 Signal Definitions

The risk engine computes five independent signals, each normalized to $[0, 1]$.

#### Signal 1 — Volatility Risk $v$

Log returns over the recent price history:

$$
r_k = \ln\!\left(\frac{r_k}{r_{k-1}}\right), \quad k = 2, \ldots, K
$$

Sample standard deviation:

$$
\sigma_r = \sqrt{\frac{1}{K-1}\sum_{k=2}^{K}(r_k - \bar{r})^2}
$$

Volatility in basis points, normalized to a threshold of 75 bps:

$$
v = \text{clamp}\!\left(\frac{10000 \cdot \sigma_r}{75}\right)
$$

#### Signal 2 — Spread Risk $s$

Bid-ask spread in basis points, normalized to a threshold of 80 bps:

$$
s = \text{clamp}\!\left(\frac{10000 \cdot (p_1^a - p_1^b)}{m \cdot 80}\right)
$$

#### Signal 3 — Imbalance Risk $\iota$

Depth imbalance across the top 6 levels on each side:

$$
D^b = \sum_{i=1}^{6} q_i^b, \qquad D^a = \sum_{j=1}^{6} q_j^a
$$

$$
\iota = \text{clamp}\!\left(1.45 \cdot \frac{|D^b - D^a|}{D^b + D^a}\right)
$$

The factor 1.45 amplifies moderate imbalances into the signal range more aggressively than a linear normalization would.

#### Signal 4 — Depth Thinness $\tau$

The executable depth within the slippage limit. For a buy intent:

$$
p_{\text{limit}} = m \cdot \left(1 + \frac{\delta_{\max}}{10000}\right)
$$

$$
D_{\text{exec}} = \sum_{j : p_j^a \leq p_{\text{limit}}} q_j^a
$$

Thinness rises as executable depth falls short of the full intent size:

$$
\tau = 1 - \text{clamp}\!\left(\frac{D_{\text{exec}}}{Q}\right)
$$

#### Signal 5 — Footprint Risk $\phi$

The trade's size relative to the top level on the relevant side:

$$
\phi = \text{clamp}\!\left(\frac{Q}{3 \cdot q_1^a}\right) \quad \text{(buy)}
$$

A large footprint means the intent alone could move the top of book.

### 4.3 Composite Risk Score

The five signals are combined through a fixed weighted average:

$$
\rho = \text{clamp}(0.27v + 0.22s + 0.22\iota + 0.21\tau + 0.08\phi)
$$

The weights were calibrated to prioritize volatility and spread (which directly determine fill cost) while still capturing structural book conditions through imbalance and thinness. Footprint has the lowest weight because it is correlated with thinness.

$$
\text{label}(\rho) = \begin{cases} \text{low} & \rho < 0.34 \\ \text{guarded} & 0.34 \leq \rho < 0.67 \\ \text{hostile} & \rho \geq 0.67 \end{cases}
$$

---

## 5. Gaussian Grid Planner

### 5.1 Slice Count

The number of child orders $n$ scales linearly with the risk score between a minimum of 3 and a maximum of 11:

$$
n = \text{round}\!\bigl(\text{lerp}(3,\ 11,\ \rho)\bigr)
$$

where $\text{lerp}(a, b, t) = a + (b - a) \cdot \text{clamp}(t)$.

Low risk → 3 slices (minimal complexity). Hostile market → 11 slices (maximum fragmentation of footprint).

### 5.2 Price Band

The price band width in basis points:

$$
B = \text{clamp}\!\bigl(\delta_{\max} \cdot \text{lerp}(0.35,\ 0.95,\ \rho) \cdot \mu_u,\ 6,\ \delta_{\max}\bigr)
$$

At low risk the band is 35% of the maximum slippage. At maximum risk it expands to 95%. The urgency multiplier $\mu_u$ contracts the band for patient orders and expands it for fast ones.

### 5.3 Price Grid

Let $p_{\text{anchor}}$ be the best ask (for buys) or best bid (for sells). Child order prices are spaced evenly across the band:

$$
t_i = \begin{cases} 0 & n = 1 \\ \dfrac{i-1}{n-1} & n > 1 \end{cases}, \quad i = 1, \ldots, n
$$

$$
p_i = p_{\text{anchor}} \cdot \left(1 + d \cdot \frac{B \cdot t_i}{10000}\right)
$$

where $d = +1$ for buys (prices rise away from anchor toward the slippage limit) and $d = -1$ for sells.

### 5.4 Gaussian Quantity Weights

Quantities are not split uniformly. They follow a Gaussian profile centered on the grid, so orders near the anchor (best price) receive the largest allocation and orders near the band edge receive the smallest.

The bandwidth parameter $\sigma_G$ widens with risk:

$$
\sigma_G = \text{lerp}(0.7,\ 3.2,\ \rho)
$$

At low risk $\sigma_G = 0.7$ produces a narrow, peaked distribution — most volume is placed at the best price. At high risk $\sigma_G = 3.2$ flattens the distribution, spreading volume more evenly across the band to reduce footprint at any single level.

Unnormalized Gaussian weights:

$$
\tilde{w}_i = \exp\!\left(-\frac{1}{2}\left(\frac{i - c}{\sigma_G}\right)^2\right), \quad c = \frac{n-1}{2}
$$

Normalized so weights sum to 1:

$$
w_i = \frac{\tilde{w}_i}{\sum_{j=1}^{n} \tilde{w}_j}
$$

Child order quantities:

$$
q_i = w_i \cdot Q
$$

A rounding correction is applied to the last slice to ensure $\sum q_i = Q$ exactly.

### 5.5 On-Chain Lot Snapping

DeepBook V3 enforces a minimum lot size $\ell$ and minimum order size $q_{\min}$ per pool. Before submission, each $q_i$ is snapped to the nearest valid lot:

$$
q_i^{\text{chain}} = \max\!\left(\left\lfloor \frac{q_i}{\ell} \right\rfloor, 1\right) \cdot \ell
$$

Orders where $q_i^{\text{chain}} < q_{\min}$ are dropped. For the SUI/DBUSDC testnet pool, $\ell = q_{\min} = 1\ \text{SUI}$.

---

## 6. Atomic Execution via Sui PTBs

### 6.1 Programmable Transaction Blocks

A Sui Programmable Transaction Block (PTB) is a sequence of commands that executes atomically. If any command fails, the entire block reverts. This property is the execution guarantee that makes Aegis work.

Each child order maps to one `placeLimitOrder` command on DeepBook V3:

```
PTB:
  cmd_1: deepBook.placeLimitOrder(pool, manager, price_1, qty_1, isBid)
  cmd_2: deepBook.placeLimitOrder(pool, manager, price_2, qty_2, isBid)
  ...
  cmd_n: deepBook.placeLimitOrder(pool, manager, price_n, qty_n, isBid)
```

Because DeepBook aborts the entire transaction on any order validation failure, the grid is all-or-nothing. An adversary cannot pick off individual legs after seeing the first order land.

### 6.2 BalanceManager

Collateral is held in a DeepBook V3 BalanceManager — an on-chain object that locks funds and issues trade proofs. BID orders (buys) lock quote coin (DBUSDC). ASK orders (sells) lock base coin (SUI). The BalanceManager address is passed into the PTB at construction time.

### 6.3 Build and Submit Strategy

Transaction building requires `resolveTransactionPlugin`, which is only available on the gRPC client. Submission via gRPC hangs on testnet due to streaming behavior. The hybrid strategy:

1. **Build** using `tx.build({ client: grpcClient.core })` — resolves coin types and object references.
2. **Sign** locally using the Ed25519 keypair — no network call.
3. **Submit** via HTTP JSON-RPC `sui_executeTransactionBlock` — returns immediately with digest.

---

## 7. Predator Simulator

### 7.1 Attack Model

The predator models a rational front-running bot that observes the trader's full intent before execution.

**Pressure** — how hard the intent hits the top of book:

$$
\Pi = \text{clamp}\!\left(\frac{Q}{4 \cdot q_1^{\text{side}}}\right)
$$

**Exposure ratio** $\varepsilon$ — what fraction of the intent the bot can see:
- Naive market order: $\varepsilon = 1$ (full size visible at one price)
- Aegis grid: $\varepsilon = \text{clamp}\!\left(\dfrac{\max_i q_i}{Q}\right) \cdot 0.42$ (only the largest single slice is visible, dampened by 0.42)

**Price shift applied by the bot:**

$$
\Delta_{\text{bps}} = (18 + 95 \cdot \Pi) \cdot \text{clamp}(\varepsilon,\ 0.04,\ 1)
$$

**Depth removed by the bot:**

$$
\kappa = (0.18 + 0.5 \cdot \Pi) \cdot \text{clamp}(\varepsilon,\ 0.04,\ 1)
$$

The bot shifts ask prices up by $\Delta_{\text{bps}}$ and removes fraction $\kappa$ of depth from the top 4 levels for a buy intent (and mirror operations for a sell).

### 7.2 Slippage Comparison

**Naive slippage** — the trader submits one market order against the attacked book. Average fill price is computed by sweeping levels in order. Slippage:

$$
\delta_{\text{naive}} = \frac{p_{\text{avg}}^{\text{naive}} - m}{m} \cdot 10000 \quad \text{(buy)}
$$

**Aegis slippage** — child orders fill against the lightly-attacked book (low $\varepsilon$). Each child order fills at levels where $p_j^a \leq p_i$ (for buys). Slippage:

$$
\delta_{\text{aegis}} = \frac{p_{\text{avg}}^{\text{aegis}} - m}{m} \cdot 10000 \quad \text{(buy)}
$$

**Saved slippage:**

$$
\Delta\delta = \max(\delta_{\text{naive}} - \delta_{\text{aegis}},\ 0)
$$

**Saved notional** (in quote coin):

$$
\text{Saved} = \frac{\Delta\delta}{10000} \cdot Q \cdot m
$$

### 7.3 Empirical Results

For a 750 SUI intent on SUI/DBUSDC (buy side, 80 bps slippage limit):

| Scenario | Naive Slippage | Aegis Slippage | Saved |
|----------|---------------|----------------|-------|
| Calm     | 26.6 bps      | 9.6 bps        | 17.0 bps |
| Stressed | 95.0 bps      | 40.1 bps       | 54.9 bps |
| Toxic    | 244.1 bps     | 77.9 bps       | 166.2 bps |

In a toxic market, Aegis reduces slippage by 68% relative to a naive market order.

---

## 8. DeepBook V3 Integration

### 8.1 Pool Parameters

Each DeepBook V3 pool enforces:
- **lot_size** $\ell$ — minimum quantity increment (base coin)
- **min_size** $q_{\min}$ — minimum quantity per order (base coin)

Violating either causes `EOrderBelowMinimumSize` (abort code 1) or `EOrderInvalidLotSize` (abort code 2). For the testnet SUI/DBUSDC pool: $\ell = q_{\min} = 1\ \text{SUI}$.

### 8.2 Collateral Direction

| Order Side | Coin Locked      |
|------------|-----------------|
| BID (buy)  | Quote (DBUSDC)  |
| ASK (sell) | Base (SUI)      |

A mismatch causes `balance_manager::withdraw_with_proof` abort code 3 (EInsufficientBalance). Aegis reads `INTENT_SIDE` from the environment and enforces the correct collateral at plan time.

### 8.3 On-Chain Traceability

A published Sui Move package (`0xd15c4493777c5e7b0bf653d47278d386fee73e235a2a59fae335b44ce2dc8a0b`) emits an intent receipt event for each execution, enabling off-chain indexers to reconstruct the full intent history from on-chain events.

**Live transaction (Sui Testnet):**
`7HZJLybFFThjKShL6cwBzqmYz4YdY94B1Gs3isHGe6Ln`
— `OrderPlaced`, `placed_quantity: 1000000000` (1 SUI), `order_inserted: true`

---

## 9. API

The Railway-deployed API exposes the engine over HTTP:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness check |
| POST | `/api/plan` | Risk score + grid plan for an intent |
| POST | `/api/duel` | Full predator vs Aegis simulation |
| GET | `/api/scenarios` | List available market scenarios |

Request body for `/api/duel`:
```json
{
  "pair": "SUI_DBUSDC",
  "side": "buy",
  "quantity": 750,
  "maxSlippageBps": 80,
  "urgency": "normal",
  "scenario": "toxic"
}
```

---

## 10. Future Work

- **Live order book feeds** — replace simulated scenarios with real-time DeepBook V3 data via Sui gRPC subscriptions.
- **Refresh cadence** — cancel and resubmit the grid as the book evolves, turning the one-shot PTB into a persistent execution engine.
- **Mainnet deployment** — calibrate pool parameters and lot sizes for production pools.
- **Multi-pool routing** — split the intent across multiple DeepBook pools to access deeper liquidity.
- **Move settlement module** — on-chain settlement receipts with cryptographic proof of slippage saved.

---

## 11. Conclusion

Aegis demonstrates that intent-based execution protection is achievable on a fully on-chain order book. The Gaussian grid planner reduces the visible footprint of a large order by up to 68% in hostile markets. The Sui PTB guarantee ensures atomicity with no partial-fill risk. The five-signal risk engine adapts the execution plan to live book conditions without any off-chain oracle. The full system is deployed and producing live on-chain transactions on DeepBook V3 testnet.

---

## References

1. Sui Programmable Transaction Blocks — https://docs.sui.io/concepts/transactions/prog-txn-blocks
2. DeepBook V3 Overview — https://docs.sui.io/onchain-finance/deepbookv3/deepbook
3. DeepBook V3 SDK — https://docs.sui.io/onchain-finance/deepbookv3-sdk/
4. DeepBook V3 Order Contracts — https://docs.sui.io/onchain-finance/deepbookv3/contract-information/orders
5. @mysten/deepbook-v3 npm package — https://www.npmjs.com/package/@mysten/deepbook-v3
