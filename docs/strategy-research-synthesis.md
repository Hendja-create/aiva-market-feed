# AIVA research synthesis: five open-source trading projects

Date: 2026-11-13

This note records transferable design ideas and AIVA-specific evidence. It is an original synthesis, not a copy of source code or a claim that any upstream strategy is profitable.

## Repository comparison

| Repository | Useful contribution | Limitation for AIVA |
|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | Specialist analysis, opposing bull/bear review, chronological backtests, point-in-time memory and outcome settlement | Designed as a broad research workflow; its own documentation warns that decision-quality backtests are not portfolio simulations and that some external text feeds are not archived |
| [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) | Regime gate, circuit breaker, pre-trade checklist, trade journal, attribution and postmortem feedback | Human decision-support workflow, not a low-latency XAUUSD scalper or an execution engine |
| [je-suis-tm/quant-trading](https://github.com/je-suis-tm/quant-trading) | Useful quantitative examples and an unusually candid demonstration of curve fitting and Monte Carlo limits | Several examples assume frictionless fills; its Monte Carlo example shows that increasing simulation count does not repair a poor directional model |
| [freqtrade/freqtrade-strategies](https://github.com/freqtrade/freqtrade-strategies) | Reusable indicator patterns, regime and multi-timeframe context, stop/cooldown/drawdown protections, backtest plus dry-run discipline | Example parameters are asset/timeframe specific; crypto spot/futures strategies cannot be transplanted directly to gold CFD M5 |
| [Alorse/pinescript-strategies](https://github.com/Alorse/pinescript-strategies) | Reproducible script validation and a visible comparison of win rate, net return, drawdown and Sharpe | Its committed benchmark uses BTCUSDT daily data for all strategies, with Pine v4 and multi-timeframe compatibility gaps; results are not an XAUUSD M5 benchmark |

## What the source repositories teach

1. Keep historical evaluation point-in-time safe. An analysis dated in the past must not see later candles, later outcomes or lessons that were not known then.
2. Separate signal generation, risk permission, execution accounting and outcome review. A strong signal must not bypass a circuit breaker.
3. Use Monte Carlo for uncertainty and stress-testing the distribution of outcomes, not as a directional oracle.
4. Count Bid/Ask, spread, slippage and commission. A frictionless backtest cannot establish a tradable edge.
5. Compare win rate with expectancy, profit factor, drawdown, losing streaks, sample size and chronological stability. A high win rate alone can still lose money.
6. Promote nothing automatically. A scorecard can request review; a separate evidence gate remains responsible for strategy eligibility.

## AIVA evidence checked for this synthesis

Read-only database checks on 2026-11-13 found:
- 25,138 complete XAUUSD M5 Bid/Ask candle rows, from 2026-08-02 through 2026-11-12.
- 478 stored backtest rows across 35 methods.
- No stored row passed the combined current eligibility criteria when sample size, OOS profit factor, positive expectancy/net PnL, freshness and methodology warnings were considered together.
- The best average result among the 13 current tournament configurations was session momentum 12:00–16:00 UTC: approximately 43.0% average OOS win rate and 0.934 average OOS profit factor across 18 runs. This is not profitable evidence.

A controlled replay on the available M5 history used the current tournament assumptions: chronological 70/30 split, next-bar Bid/Ask entry, spread ceiling 1.5 points, ATR-based stop, 1.5R target, six-bar maximum holding period, stop-first intrabar ambiguity, 0.05-point slippage per side and 0.20-point round-trip commission.

| Candidate replay | OOS trades | OOS win rate | OOS profit factor | OOS net points |
|---|---:|---:|---:|---:|
| Session momentum 12:00–16:00 UTC | 140 | 42.1% | 0.851 | -66.81 |
| EMA pullback | 211 | 40.3% | 0.767 | -117.58 |
| Experimental EMA/ATR/RSI/session confluence | 10 | 40.0% | 0.620 | -14.16 |

The confluence experiment reduced trade count but did not improve expectancy. It is deliberately not added to the executable strategy registry.

## New AIVA component: evidence scorecard

`src/evidence-scorecard.js` adds a deterministic, research-only report for chronological OOS trades:
- Wilson 95% interval for the observed win rate.
- Profit factor, net PnL, expectancy, drawdown and consecutive losses.
- Three chronological sub-periods.
- Performance breakdown by labelled market regime.
- An additional per-trade cost stress.
- Explicit failure reasons when OOS evidence is too small, not profitable or not cost-resilient.

The scorecard is attached to the strategy tournament report only. It does not change entries, exits, strategy selection, adaptive thresholds, demo trades or risk locks. A passing result is marked for human review and is never an automatic promotion.
