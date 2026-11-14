import http from "node:http";

const port = Number(process.env.PORT || 3000);
const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : "";
}

async function timedFetch(url, options) {
  const started = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(8000)
  });
  return { response, durationMs: Number((performance.now() - started).toFixed(2)) };
}

async function authenticate(token) {
  if (!baseUrl || !publishableKey || !token) {
    return { ok: false, status: 401, reason: "missing_credentials" };
  }
  const { response, durationMs } = await timedFetch(baseUrl + "/auth/v1/user", {
    headers: {
      apikey: publishableKey,
      Authorization: "Bearer " + token
    }
  });
  if (!response.ok) {
    return { ok: false, status: response.status, durationMs };
  }
  const user = await response.json();
  return { ok: Boolean(user?.id), status: response.status, durationMs };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && path === "/health") {
    return json(res, 200, {
      ok: true,
      service: "aiva-staging-http-probe",
      configured: Boolean(baseUrl && publishableKey),
      supabaseUrlConfigured: Boolean(baseUrl),
      publishableKeyConfigured: Boolean(publishableKey)
    });
  }

  if (req.method !== "GET" || !["/test/auth", "/test/db-read"].includes(path)) {
    return json(res, 404, { error: "not_found" });
  }

  const token = bearer(req);
  try {
    const auth = await authenticate(token);
    if (!auth.ok) {
      return json(res, auth.status === 401 ? 401 : 502, {
        ok: false,
        stage: "auth",
        status: auth.status,
        durationMs: auth.durationMs ?? null
      });
    }

    if (path === "/test/auth") {
      return json(res, 200, {
        ok: true,
        stage: "auth",
        authDurationMs: auth.durationMs
      });
    }

    const { response, durationMs } = await timedFetch(
      baseUrl + "/rest/v1/aiva_staging_probe?select=id&limit=1",
      {
        headers: {
          apikey: publishableKey,
          Authorization: "Bearer " + token
        }
      }
    );
    if (!response.ok) {
      return json(res, 502, {
        ok: false,
        stage: "db",
        status: response.status,
        authDurationMs: auth.durationMs,
        dbDurationMs: durationMs
      });
    }
    const rows = await response.json();
    return json(res, 200, {
      ok: true,
      stage: "auth+db",
      authDurationMs: auth.durationMs,
      dbDurationMs: durationMs,
      visibleRows: Array.isArray(rows) ? rows.length : null
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      stage: "upstream",
      error: error?.name === "TimeoutError" ? "upstream_timeout" : "upstream_error"
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "staging_probe_started", port }));
});
