# Solana DLMM Engine

Autonomous liquidity management engine for [Meteora DLMM](https://www.meteora.ag/) concentrated liquidity pools on Solana. Runs multiple LP strategies simultaneously, auto-rebalances when price moves out of range, and tracks PnL with full accuracy across repositions.

Built for the SOL/USDC DLMM pool (Bin Step 10), but adaptable to any Meteora DLMM pair.

## Features and stuff!

- **Multi-strategy execution** Runs multiple bin-width strategies (e.g. 9-bin, 19-bin, 31-bin) on the same pool simultaneously, each with independent analytics and rebalance logic
- **Autonomous rebalancing** Detects when price leaves the position range, withdraws liquidity, swaps via Jupiter to rebalance 50/50, and deploys a new position centered on the current price
- **Accurate PnL tracking** Separates realized vs unrealized IL and fees across repositions. PnL is anchored to the original deposit and accounts for all rebalance costs (tx fees, slippage, rent cycling)
- **Take-profit fee exclusion** Harvested fees are left in the wallet as realized profit, not auto-compounded back into the position
- **Live dashboard** Real-time browser UI showing position value, IL, fees, F/IL ratio, net PnL, volatility, and directional bias per strategy
- **Safety gates** Configurable guards: minimum rebalance interval, fee-must-cover-cost gate, volatility cooldown (Bollinger-based), and out-of-range bin threshold
- **Kill switch** Emergency withdrawal of all positions via dashboard button, socket event, or HTTP endpoint
- **Manual reposition** Dashboard button to force a rebalance on any strategy for testing/debugging

## Architecture

```
src/
  analytics/        Fee tracking, IL calculation, PnL, volatility
  config/           Strategy definitions, env var loading
  core/             RPC client, batched state fetcher, price feed (Pyth), genesis loader
  execution/        Rebalance orchestrator, safety gates, kill switch
  hedging/          Delta-neutral hedging (scaffold — not yet active)
  runners/          Per-strategy state machine with realized/unrealized metric persistence
  services/         Meteora SDK wrapper, Jupiter swap service, transaction sender
  server.ts         Express + Socket.io dashboard server
  index.ts          Main entry point and poll loop
```

**RPC efficienty:** One batched `getMultipleAccountsInfo` call per poll cycle for all strategies. Price comes from Pyth HTTP (not an RPC call).

**safety:** A semaphore serializes rebalances so multiple strategies sharing one wallet never collide. Baseline isolation ensures only position funds are touched — other wallet assets are protected.

## Setup

### Prerequisites

- Node.js 18+
- A Solana RPC endpoint (Helius, QuickNode, etc. — public RPC rate-limits aggressively)
- A funded wallet with SOL/USDC and an open Meteora DLMM position

### Install

```bash
git clone https://github.com/bmhuang8/solana-dlmm-engine.git
cd solana-dlmm-engine
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` with your values:

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | Yes | Solana RPC endpoint |
| `POSITION_PUBKEY_01` | Yes | Your DLMM position account pubkey |
| `EXECUTION_ENABLED` | No | Set `true` to enable autonomous rebalancing |
| `WALLET_PRIVATE_KEY` | If executing | Base58 or JSON byte array private key |
| `DASHBOARD_PASSWORD` | No | Password gate for the web dashboard |

To find your position pubkey:

```bash
npm run discover
```

### Run

**Monitor only** (read-only, no rebalancing):
```bash
npm start
```

**With autonomous rebalancing:**
```bash
# In .env, set:
# EXECUTION_ENABLED=true
# WALLET_PRIVATE_KEY=<your-key>
npm start
```

Dashboard available at `http://localhost:3000`

## Strategies

Strategies are defined in `src/config/settings.ts`. Each strategy gets:

- Its own position with a configurable bin radius
- Independent fee/IL/PnL tracking with persistence across restarts
- Per-strategy overrides for rebalance interval, fee gate multiplier, and range threshold

Example configuration:

```typescript
{
  id: "strategy-01",
  label: "S01-9BIN",
  positionPubkey: requireEnv("POSITION_PUBKEY_01"),
  binRadius: 4,              // 9 bins total
  strategyType: 0,           // Spot distribution
  outOfRangeBinThreshold: 0, // rebalance immediately when out of range
  minRebalanceIntervalMs: 0, // no cooldown
  feeGateMultiplier: 1.0,    // fees must cover 1x tx cost
}
```

## How Rebalancing Works

1. **Detect** Price leaves the position's bin range (configurable threshold)
2. **Safety gates** All gates must pass (interval, fee coverage, volatility, etc.)
3. **Snapshot** Capture realized IL and fees before closing the old position
4. **Withdraw** Close position with `shouldClaimAndClose` (returns liquidity + fees + rent)
5. **Separate fees** Subtract known fee amounts from the wallet delta (take-profit cap)
6. **Swap** Jupiter V6 swap to rebalance the liquidity-only portion to ~50/50
7. **Deploy** Open new position centered on current active bin
8. **Measure** Record true rebalance cost from wallet delta (excluding rent and fees)

Rent cycling is handled automatically — the old position's rent refund is excluded from liquidity calculations, and the new position's rent is excluded from cost measurement.

## PnL Model

```
Net PnL = Position Value + Total Fees - Original Entry Value - Rebalance Costs

Total IL    = Realized IL (from past repositions) + Unrealized IL (current position)
Total Fees  = Realized Fees (from past repositions) + Unrealized Fees (current position)
```

- **Entry value** is recovered from on-chain transaction history (genesis loader) using Pyth historical prices
- **Realized metrics** persist to `data/rebal-costs-{id}.json` and survive restarts
- **Unrealized metrics** are computed fresh each tick from the current on-chain position state

## Dashboard

The live dashboard shows per-strategy cards with:

| Metric | Description |
|---|---|
| Position | Current USDC value of LP tokens |
| Rebal cost | Lifetime rebalance costs (tx fees + slippage) |
| IL | Total impermanent loss (realized + unrealized) |
| Fees earned | Total fees (realized + unrealized) |
| F/IL | Fee-to-IL coverage ratio |
| Net PnL | Bottom line: fees - IL - costs |
| iVol | Interval volatility (rolling window) |
| Bias | Directional price bias with arrow indicator |

Each card has a **Reposition** button for manual rebalancing and there is a global **Kill** button for emergency withdrawal.

## License

MIT
