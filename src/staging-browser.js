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
  out.textContent = "Étape 1/2 : connexion au projet de test…";
  var token = "";
  var levels = [1, 2, 4, 8, 16, 32];
  var results = [];
  var total = 1800;
  var finished = 0;
  function percentile(values, p) {
    if (!values.length) return 0;
    values.sort(function (a, b) { return a - b; });
    return values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
  }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  try {
    var cfgResponse = await fetch("/test/config", { cache: "no-store" });
    if (!cfgResponse.ok) throw new Error("Impossible de lire la configuration du test.");
    var cfg = await cfgResponse.json();
    if (!cfg.configured) throw new Error("Configuration Supabase incomplète.");
    var loginResponse = await fetch(cfg.supabaseUrl + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: cfg.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password })
    });
    document.getElementById("password").value = "";
    if (!loginResponse.ok) throw new Error("Connexion refusée. Vérifie le compte de test du projet aiva-staging.");
    var loginData = await loginResponse.json();
    token = loginData.access_token;
    if (!token) throw new Error("Supabase n’a pas retourné de jeton de session.");
    for (var repetition = 1; repetition <= 3; repetition++) {
      for (var li = 0; li < levels.length; li++) {
        var concurrency = levels[li];
        var durations = [], authDurations = [], dbDurations = [], errors = 0;
        var started = performance.now();
        var completed = 0;
        while (completed < 100) {
          var count = Math.min(concurrency, 100 - completed);
          var jobs = [];
          for (var j = 0; j < count; j++) {
            jobs.push((async function () {
              var t = performance.now();
              try {
                var response = await fetch("/test/db-read", {
                  headers: { Authorization: "Bearer " + token },
                  cache: "no-store"
                });
                var body = await response.json();
                return { ok: response.ok && body.ok, ms: performance.now() - t, authMs: body.authDurationMs, dbMs: body.dbDurationMs };
              } catch (error) {
                return { ok: false, ms: performance.now() - t };
              }
            })());
          }
          var batch = await Promise.all(jobs);
          for (var k = 0; k < batch.length; k++) {
            var item = batch[k];
            durations.push(item.ms);
            if (!item.ok) errors++;
            if (typeof item.authMs === "number") authDurations.push(item.authMs);
            if (typeof item.dbMs === "number") dbDurations.push(item.dbMs);
          }
          completed += count;
          finished += count;
          out.textContent = "Benchmark en cours : répétition " + repetition + "/3, concurrence " + concurrency + ", " + finished + "/" + total + " lectures terminées.";
        }
        var elapsed = performance.now() - started;
        results.push({
          repetition: repetition, concurrency: concurrency, requests: 100, errors: errors,
          p50_ms: +percentile(durations, 0.50).toFixed(1),
          p95_ms: +percentile(durations, 0.95).toFixed(1),
          p99_ms: +percentile(durations, 0.99).toFixed(1),
          auth_p50_ms: +percentile(authDurations, 0.50).toFixed(1),
          db_p50_ms: +percentile(dbDurations, 0.50).toFixed(1),
          throughput_rps: +(100 / (elapsed / 1000)).toFixed(2)
        });
        out.textContent = "Benchmark en cours : " + finished + "/" + total + " lectures.\n" + JSON.stringify(results, null, 2);
        await wait(1500);
      }
    }
    out.textContent = "Benchmark terminé : " + finished + "/" + total + " lectures.\n" + JSON.stringify(results, null, 2);
  } catch (error) {
    out.textContent = "Erreur : " + (error && error.message ? error.message : "échec inattendu");
  } finally {
    token = "";
    button.disabled = false;
  }
};
