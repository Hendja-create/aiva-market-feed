const HORIZONS_MINUTES = [5, 15, 30, 60];
const SLIPPAGE_PER_SIDE = 0.05;
const ROUND_TRIP_COMMISSION = 0.20;
const MAX_QUOTE_AGE_MS = 90000;
const MAX_EXIT_DELAY_MS = 10 * 60 * 1000;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function queryTickPath(symbol, since) {
  return "market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
    "&received_at=gte." + encodeURIComponent(since) +
    "&select=bid,ask,mid,spread,provider_timestamp,received_at,source" +
    "&order=received_at.asc&limit=2000";
}

export async function collectResearchObservations(db, symbol) {
  const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const analyses = await db("market_analysis_runs?symbol=eq." + encodeURIComponent(symbol) +
    "&created_at=gte." + encodeURIComponent(cutoff) +
    "&select=id,symbol,decision,features,created_at&order=created_at.asc&limit=100");
  let inserted = 0;
  let skipped = 0;

  for (const analysis of analyses) {
    const diagnostics = analysis.features?.decision_diagnostics || {};
    const direction = diagnostics.candidate_direction ||
      (analysis.decision === "BUY" || analysis.decision === "SELL" ? analysis.decision : null);
    if (!["BUY", "SELL"].includes(direction) || !analysis.id) {
      skipped++;
      continue;
    }

    const quoteRows = await db("market_quote_ticks?symbol=eq." + encodeURIComponent(symbol) +
      "&received_at=lte." + encodeURIComponent(analysis.created_at) +
      "&select=bid,ask,mid,spread,provider_timestamp,received_at,source" +
      "&order=received_at.desc&limit=1");
    const quote = quoteRows[0];
    const bid = finite(quote?.bid), ask = finite(quote?.ask);
    const quoteAt = quote?.received_at ? new Date(quote.received_at).getTime() : NaN;
    const analysisAt = new Date(analysis.created_at).getTime();
    const age = analysisAt - quoteAt;
    if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(age) ||
        age < 0 || age > MAX_QUOTE_AGE_MS) {
      skipped++;
      continue;
    }

    const payload = {
      source_analysis_id: analysis.id,
      symbol,
      direction,
      source_decision: analysis.decision,
      blocking_reasons: diagnostics.blocking_reasons || [],
      candidate_probability: finite(diagnostics.candidate_probability),
      confidence: finite(analysis.confidence),
      entry_bid: bid,
      entry_ask: ask,
      entry_spread: ask - bid,
      entry_quote_at: quote.received_at,
      entry_provider_timestamp: quote.provider_timestamp || null,
      entry_quote_source: quote.source || "unknown",
      created_at: analysis.created_at,
      status: "OPEN",
      execution_assumptions: {
        mode: "research_paper_only",
        slippage_per_side_points: SLIPPAGE_PER_SIDE,
        commission_round_trip_points: ROUND_TRIP_COMMISSION,
        horizons_minutes: HORIZONS_MINUTES,
        risk_limits_applied: false,
        real_orders_enabled: false
      }
    };
    const saved = await db("aiva_research_observations?on_conflict=source_analysis_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(payload)
    });
    if (Array.isArray(saved) && saved.length) inserted++;
  }

  return { analyses_seen: analyses.length, observations_inserted: inserted, skipped };
}

function evaluateHorizon(observation, quote, minutes) {
  const direction = observation.direction;
  const entry = direction === "BUY"
    ? finite(observation.entry_ask) + SLIPPAGE_PER_SIDE
    : finite(observation.entry_bid) - SLIPPAGE_PER_SIDE;
  const exit = direction === "BUY"
    ? finite(quote.bid) - SLIPPAGE_PER_SIDE
    : finite(quote.ask) + SLIPPAGE_PER_SIDE;
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  const gross = direction === "BUY" ? exit - entry : entry - exit;
  const net = gross - ROUND_TRIP_COMMISSION;
  return {
    horizon_minutes: minutes,
    exit_quote_at: quote.received_at,
    exit_provider_timestamp: quote.provider_timestamp || null,
    exit_bid: finite(quote.bid),
    exit_ask: finite(quote.ask),
    exit_spread: finite(quote.ask) - finite(quote.bid),
    gross_pnl_points: Number(gross.toFixed(5)),
    slippage_points: Number((SLIPPAGE_PER_SIDE * 2).toFixed(5)),
    commission_points: ROUND_TRIP_COMMISSION,
    net_pnl_points: Number(net.toFixed(5)),
    outcome: net > 0 ? "WIN" : net < 0 ? "LOSS" : "FLAT",
    accounting: "Bid/Ask plus slippage and round-trip commission"
  };
}

export async function runResearchCycle(db, symbol) {
  const collection = await collectResearchObservations(db, symbol);
  const openRows = await db("aiva_research_observations?symbol=eq." + encodeURIComponent(symbol) +
    "&status=eq.OPEN&select=id,direction,entry_bid,entry_ask,created_at,outcome_5m,outcome_15m,outcome_30m,outcome_60m" +
    "&order=created_at.asc&limit=200");
  if (!openRows.length) return { ...collection, open_observations: 0, evaluated: 0 };

  const earliestDue = Math.min(...openRows.map(row => new Date(row.created_at).getTime() + 5 * 60000));
  const now = Date.now();
  const since = new Date(earliestDue - 1000).toISOString();
  const ticks = await db(queryTickPath(symbol, since));
  let evaluated = 0;

  for (const observation of openRows) {
    const createdAt = new Date(observation.created_at).getTime();
    const patch = {};
    for (const minutes of HORIZONS_MINUTES) {
      const outcomeKey = "outcome_" + minutes + "m";
      if (observation[outcomeKey]) continue;
      const dueAt = createdAt + minutes * 60000;
      if (now < dueAt) continue;
      const quote = ticks.find(tick => new Date(tick.received_at).getTime() >= dueAt);
      if (quote) {
        const result = evaluateHorizon(observation, quote, minutes);
        if (result) {
          patch[outcomeKey] = result;
          patch["evaluated_" + minutes + "m_at"] = new Date().toISOString();
        }
      } else if (now > dueAt + MAX_EXIT_DELAY_MS) {
        patch[outcomeKey] = {
          horizon_minutes: minutes,
          outcome: "INVALID",
          reason: "No quote available within the 10-minute evaluation window"
        };
        patch["evaluated_" + minutes + "m_at"] = new Date().toISOString();
      }
    }
    if (Object.keys(patch).length) {
      const allDone = HORIZONS_MINUTES.every(minutes =>
        patch["outcome_" + minutes + "m"] || observation["outcome_" + minutes + "m"]);
      if (allDone) patch.status = "CLOSED";
      await db("aiva_research_observations?id=eq." + encodeURIComponent(observation.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch)
      });
      evaluated++;
    }
  }
  return { ...collection, open_observations: openRows.length, evaluated };
}

export async function getResearchStatus(db, symbol) {
  const rows = await db("aiva_research_observations?symbol=eq." + encodeURIComponent(symbol) +
    "&select=id,direction,source_decision,blocking_reasons,created_at,outcome_5m,outcome_15m,outcome_30m,outcome_60m,status" +
    "&order=created_at.desc&limit=2000");
  const horizons = {};
  for (const minutes of HORIZONS_MINUTES) {
    const results = rows.map(row => row["outcome_" + minutes + "m"])
      .filter(value => value && ["WIN", "LOSS", "FLAT"].includes(value.outcome));
    const wins = results.filter(value => value.outcome === "WIN").length;
    const losses = results.filter(value => value.outcome === "LOSS").length;
    const net = results.reduce((sum, value) => sum + Number(value.net_pnl_points || 0), 0);
    horizons[minutes + "m"] = {
      evaluated: results.length, wins, losses,
      win_rate: results.length ? Number((wins / results.length).toFixed(4)) : null,
      net_pnl_points: Number(net.toFixed(5)),
      expectancy_points: results.length ? Number((net / results.length).toFixed(5)) : null
    };
  }
  return {
    symbol, mode: "RESEARCH_PAPER_ONLY", real_orders_enabled: false,
    risk_limits_applied: false,
    observations: rows.length,
    open: rows.filter(row => row.status === "OPEN").length,
    source_decisions: {
      accepted: rows.filter(row => row.source_decision === row.direction).length,
      blocked_or_no_trade: rows.filter(row => row.source_decision === "NO_TRADE").length
    },
    horizons,
    collection_started_at: rows.length ? rows[rows.length - 1].created_at : null,
    warning: "Overlapping observations may be correlated. This dashboard is descriptive, not proof of profitability."
  };
}
