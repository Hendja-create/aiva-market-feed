window.aivaRunBenchmark = async function () {
  var email = document.getElementById("email").value.trim();
  var password = document.getElementById("password").value;
  var button = document.getElementById("run");
  var out = document.getElementById("result");
  if (!email || !password) {
    out.textContent = "Saisis l’e-mail et le mot de passe du compte de test.";
    return;
  }
  button.disabled = true;
  out.textContent = "Connexion au projet de test…";
  var token = "";
  var levels = [8, 16, 32];
  var results = [];
  var total = levels.length * 3 * 100;
  var finished = 0;
  var timeoutMs = 10000;

  function percentile(values, p) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  }
  function metric(values, p) {
    var value = percentile(values, p);
    return value === null ? null : +value.toFixed(1);
  }
  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  try {
    var cfgResponse = await fetch("/test/config", {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!cfgResponse.ok) throw new Error("Impossible de lire la configuration du test.");
    var cfg = await cfgResponse.json();
    if (!cfg.configured) throw new Error("Configuration Supabase incomplète.");

    var loginResponse = await fetch(cfg.supabaseUrl + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: cfg.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    document.getElementById("password").value = "";
    if (!loginResponse.ok) throw new Error("Connexion refusée. Vérifie le compte de test du projet aiva-staging.");
    var loginData = await loginResponse.json();
    token = loginData.access_token;
    if (!token) throw new Error("Supabase n’a pas retourné de jeton de session.");

    for (var repetition = 1; repetition <= 3; repetition++) {
      for (var li = 0; li < levels.length; li++) {
        var concurrency = levels[li];
        var durations = [];
        var authDurations = [];
        var dbDurations = [];
        var errors = 0;
        var timeouts = 0;
        var statusCounts = {};
        var started = performance.now();
        var nextIndex = 0;

        async function worker() {
          while (true) {
            var index = nextIndex++;
            if (index >= 100) return;
            var requestStarted = performance.now();
            try {
              var response = await fetch("/test/db-read", {
                headers: { Authorization: "Bearer " + token },
                cache: "no-store",
                signal: AbortSignal.timeout(timeoutMs)
              });
              var body = await response.json();
              var elapsed = performance.now() - requestStarted;
              durations.push(elapsed);
              statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
              if (!response.ok || !body.ok) {
                errors++;
              } else {
                if (typeof body.authDurationMs === "number") authDurations.push(body.authDurationMs);
                if (typeof body.dbDurationMs === "number") dbDurations.push(body.dbDurationMs);
              }
            } catch (error) {
              durations.push(performance.now() - requestStarted);
              errors++;
              if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
                timeouts++;
                statusCounts.timeout = (statusCounts.timeout || 0) + 1;
              } else {
                statusCounts.network_error = (statusCounts.network_error || 0) + 1;
              }
            } finally {
              finished++;
              out.textContent = "Benchmark renforcé : répétition " + repetition + "/3, concurrence " +
                concurrency + ", " + finished + "/" + total + " lectures terminées.";
            }
          }
        }

        var workers = [];
        for (var w = 0; w < concurrency; w++) workers.push(worker());
        await Promise.all(workers);
        var elapsedMs = performance.now() - started;
        results.push({
          repetition: repetition,
          concurrency: concurrency,
          requests: 100,
          errors: errors,
          timeouts: timeouts,
          p50_ms: metric(durations, 0.50),
          p95_ms: metric(durations, 0.95),
          p99_ms: metric(durations, 0.99),
          auth_p50_ms: metric(authDurations, 0.50),
          db_p50_ms: metric(dbDurations, 0.50),
          throughput_rps: +(100 / (elapsedMs / 1000)).toFixed(2),
          status_counts: statusCounts
        });
        out.textContent = "Benchmark en cours : " + finished + "/" + total +
          " lectures.\n" + JSON.stringify(results, null, 2);
        await wait(1000);
      }
    }
    out.textContent = "Benchmark renforcé terminé : " + finished + "/" + total +
      " lectures. Timeout par requête : " + (timeoutMs / 1000) +
      " s.\n" + JSON.stringify(results, null, 2);
  } catch (error) {
    out.textContent = "Erreur : " + (error && error.message ? error.message : "échec inattendu");
  } finally {
    token = "";
    button.disabled = false;
  }
};
