// ===============================
// CAPSTONE BACKEND – SERVER.JS
// Render-ready version
// ===============================

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");
const YAML = require("yamljs");
const swaggerUi = require("swagger-ui-express");
require("dotenv").config({ quiet: true });

// ---------- Env / Logging ----------
const IS_TEST = process.env.NODE_ENV === "test";
const log = (...args) => { if (!IS_TEST) console.log(...args); };
const warn = (...args) => { if (!IS_TEST) console.warn(...args); };

const app = express();

// IMPORTANT for Render / proxies so rate limit sees real IP
app.set("trust proxy", 1);

// ---------- Middleware ----------
app.use(express.json());
app.use(cors());
app.use(helmet());

// Basic global rate limiting: 100 req / minute per IP
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
  })
);

// ---------- Database Setup ----------
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "ecommerce.db");
const INIT_SQL = path.join(__dirname, "init-sqlite.sql");

const dbFileExists = fs.existsSync(DB_FILE);
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    warn("❌ Error opening DB:", err.message);
  } else {
    log(`📦 SQLite DB ready at: ${DB_FILE}`);
  }
});

// If DB file did not exist, apply schema / seed if init file exists
if (!dbFileExists) {
  if (fs.existsSync(INIT_SQL)) {
    const schema = fs.readFileSync(INIT_SQL, "utf8");
    db.exec(schema, (err) => {
      if (err) warn("❌ Error initializing DB:", err.message);
      else log("✅ SQLite schema/seed applied");
    });
  } else {
    warn("⚠️ DB file missing and no init-sqlite.sql found – DB is empty.");
  }
}

// ---------- Swagger ----------
const swaggerPath = path.join(__dirname, "openapi.yaml");
if (fs.existsSync(swaggerPath)) {
  const swaggerDocument = YAML.load(swaggerPath);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  log("📘 Swagger UI available at /docs");
} else {
  warn("ℹ️ openapi.yaml not found – Swagger UI disabled.");
}

// ---------- Static Admin Frontend ----------
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/admin", (_, res) =>
    res.sendFile(path.join(publicDir, "admin.html"))
  );
} else {
  warn("ℹ️ public/ folder not found – /admin will not serve a page.");
}

// ---------- Health ----------
app.get("/", (req, res) =>
  res.json({ ok: true, docs: "/docs", admin: "/admin" })
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/db-health", (req, res) => {
  db.get("SELECT 1 AS result", [], (err, row) => {
    if (err) {
      return res.status(500).json({ db: "down", error: err.message });
    }
    res.json({ db: "up", result: !!row });
  });
});

// ---------- Helper ----------
function pickAuthOutcomeWeighted() {
  const r = Math.random();
  if (r < 0.7) return "SUCCESS";
  if (r < 0.9) return "INSUFFICIENT_FUNDS";
  return "SERVER_ERROR";
}

// ---------- Endpoints ----------

// List Orders (supports limit/offset)
app.get("/orders", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;

  db.all(
    "SELECT * FROM orders ORDER BY order_date DESC LIMIT ? OFFSET ?",
    [limit, offset],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Get Order Detail
app.get("/orders/:id", (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM orders WHERE order_id = ?", [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "Order not found" });

    db.get(
      "SELECT * FROM authorizations WHERE order_id = ? ORDER BY audit_date DESC LIMIT 1",
      [id],
      (err2, auth) => {
        if (err2) return res.status(500).json({ error: err2.message });

        db.get(
          "SELECT * FROM settlements WHERE order_id = ? ORDER BY settlement_date DESC LIMIT 1",
          [id],
          (err3, settle) => {
            if (err3) return res.status(500).json({ error: err3.message });

            res.json({
              order,
              lastAuthorization: auth || null,
              lastSettlement: settle || null
            });
          }
        );
      }
    );
  });
});

// Checkout / Authorization
app.post("/orders/checkout", (req, res) => {
  const { orderId, customerId, amount, last4 } = req.body;

  if (!orderId || !customerId || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const result = pickAuthOutcomeWeighted();
  const status =
    result === "SUCCESS"
      ? "AUTHORIZED"
      : result === "INSUFFICIENT_FUNDS"
      ? "DECLINED"
      : "ERROR";

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO orders(order_id, customer_id, order_amount, status_id, order_date) VALUES (?, ?, ?, ?, datetime('now'))"
  );

  stmt.run(orderId, customerId, amount, status, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    stmt.finalize();

    db.run(
      "INSERT INTO authorizations(order_id, response_id, auth_amnt, last_4, audit_date) VALUES (?, ?, ?, ?, datetime('now'))",
      [orderId, result, amount, last4 || "0000"],
      (err2) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ orderId, result, status });
      }
    );
  });
});

// Payment Settlement
app.post("/payments/settle", (req, res) => {
  const { orderId, amount } = req.body;

  if (!orderId || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  db.get(
    "SELECT order_id, status_id FROM orders WHERE order_id = ?",
    [orderId],
    (err, order) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!order) return res.status(404).json({ error: "Order not found" });
      if (order.status_id !== "AUTHORIZED") {
        return res
          .status(400)
          .json({ error: "Order not authorized, cannot settle" });
      }

      db.get(
        "SELECT auth_id FROM authorizations WHERE order_id = ? ORDER BY audit_date DESC LIMIT 1",
        [orderId],
        (err2, auth) => {
          if (err2) return res.status(500).json({ error: err2.message });

          db.run(
            "INSERT INTO settlements(order_id, auth_id, settled_amnt, settlement_stat, settlement_date) VALUES (?, ?, ?, 'SETTLED', datetime('now'))",
            [orderId, auth?.auth_id || null, amount],
            (err3) => {
              if (err3) return res.status(500).json({ error: err3.message });

              db.run(
                "UPDATE orders SET status_id='SETTLED' WHERE order_id=?",
                [orderId],
                (err4) => {
                  if (err4)
                    return res.status(500).json({ error: err4.message });
                  res.json({ orderId, paymentStatus: "SETTLED" });
                }
              );
            }
          );
        }
      );
    }
  );
});

// Stats Dashboard
app.get("/stats", (req, res) => {
  const out = { totals: {}, recentOrders: [], settled_total: 0 };

  db.all(
    "SELECT status_id, COUNT(*) AS count FROM orders GROUP BY status_id",
    [],
    (e1, rows1) => {
      if (e1) return res.status(500).json({ error: e1.message });
      rows1.forEach((r) => (out.totals[r.status_id] = r.count));

      db.get("SELECT COUNT(*) AS total FROM orders", [], (e2, row2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        out.totals.ALL = row2?.total || 0;

        db.get(
          "SELECT IFNULL(SUM(settled_amnt), 0) AS settled_total FROM settlements",
          [],
          (e3, row3) => {
            if (e3) return res.status(500).json({ error: e3.message });
            out.settled_total = Number(row3?.settled_total || 0);

            db.all(
              "SELECT order_id, customer_id, order_amount, status_id, order_date FROM orders ORDER BY order_date DESC LIMIT 5",
              [],
              (e4, rows4) => {
                if (e4) return res.status(500).json({ error: e4.message });
                out.recentOrders = rows4 || [];
                res.json(out);
              }
            );
          }
        );
      });
    }
  );
});

// ---------- Export & Listen ----------

module.exports = app;

// Only start the TCP server outside of tests
if (!IS_TEST) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => log(`✅ API running on port ${PORT}`));
}
