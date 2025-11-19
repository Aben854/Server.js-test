// =====================================
// COMBINED SERVER – JSON Server + Express
// Ready for deployment on Render
// =====================================
const fetch = require("node-fetch");
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

// ---------- Environment & Logging ----------
const IS_TEST = process.env.NODE_ENV === "test";
const log = (...args) => { if (!IS_TEST) console.log(...args); };
const warn = (...args) => { if (!IS_TEST) console.warn(...args); };

const app = express();

// Trust proxy (for rate limiting / IP on Render)
app.set("trust proxy", 1);

// ---------- Global Middleware ----------
app.use(express.json());
app.use(cors());
app.use(helmet());

// Basic rate limiting: 100 requests per minute per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// ---------- Database Setup (SQLite) ----------
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "ecommerce.db");
const INIT_SQL = path.join(__dirname, "init-sqlite.sql");

const dbFileExists = fs.existsSync(DB_FILE);
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    warn("Error opening DB:", err.message);
  } else {
    log(`SQLite DB ready at: ${DB_FILE}`);
  }
});

// If database file did not exist, initialize schema from file
if (!dbFileExists) {
  if (fs.existsSync(INIT_SQL)) {
    const schemaSql = fs.readFileSync(INIT_SQL, "utf8");
    db.exec(schemaSql, (err) => {
      if (err) {
        warn("Error initializing DB:", err.message);
      } else {
        log("SQLite schema/seed applied");
      }
    });
  } else {
    warn("DB file missing and no init-sqlite.sql found – starting with empty DB.");
  }
}

// ---------- Swagger Documentation ----------
const swaggerPath = path.join(__dirname, "openapi.yaml");
if (fs.existsSync(swaggerPath)) {
  const swaggerDocument = YAML.load(swaggerPath);
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  log("Swagger UI available at /docs");
} else {
  warn("openapi.yaml not found – Swagger UI is disabled.");
}

// ---------- Static Files (Admin Frontend) ----------
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/admin", (_, res) => {
    res.sendFile(path.join(publicDir, "admin.html"));
  });
} else {
  warn("public/ folder not found – /admin route will not serve a page.");
}

// ---------- Health Check Endpoints ----------
app.get("/", (req, res) => {
  res.json({ ok: true, docs: "/docs", admin: "/admin" });
});
app.get("/health", (req, res) => {
  res.json({ ok: true });
});
app.get("/db-health", (req, res) => {
  db.get("SELECT 1 AS result", [], (err, row) => {
    if (err) {
      return res.status(500).json({ db: "down", error: err.message });
    }
    res.json({ db: "up", result: !!row });
  });
});

// ---------- Optional Global Delay (Rule 4) ----------
if (process.env.SIMULATE_DELAY === "true") {
  app.use((req, res, next) => {
    setTimeout(() => next(), 2000);
  });
}

// Create an API router for all endpoints under /api
const apiRouter = express.Router();

// ---------- Helper Functions ----------
function pickAuthOutcomeWeighted() {
  const r = Math.random();
  if (r < 0.7) return "SUCCESS";
  if (r < 0.9) return "INSUFFICIENT_FUNDS";
  return "SERVER_ERROR";
}

// Load static response templates for payment authorization (if available)
const responsesDir = path.join(__dirname, "responses");
let successTemplate, incorrectCardTemplate, insufficientFundsTemplate, error500Template;
if (fs.existsSync(responsesDir)) {
  try {
    successTemplate = require(path.join(responsesDir, "SuccessResponse.json"));
    incorrectCardTemplate = require(path.join(responsesDir, "IncorrectCardDetailsResponse.json"));
    insufficientFundsTemplate = require(path.join(responsesDir, "InsufficentFundsResponse.json"));
    error500Template = require(path.join(responsesDir, "500ErrorResponse.json"));
  } catch (err) {
    warn("Could not load response templates: " + err.message);
  }
} else {
  warn("responses/ folder not found – some mock endpoints may not function.");
}

// ------------------------------------------------------------------
// Rule 1: Require a name when creating a customer
// ------------------------------------------------------------------
apiRouter.post("/customers", (req, res) => {
  const { name, email } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Customer name is required" });
  }
  // Insert the new customer into the database (assuming auto-increment ID)
  const sql = "INSERT INTO customers(name" + (email ? ", email" : "") + ") VALUES (?"+ (email ? ", ?" : "") +")";
  const params = email ? [name, email] : [name];
  db.run(sql, params, function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    // Respond with the created customer (ID assumed to be lastID if auto-increment)
    const newCustomerId = this.lastID;
    res.status(201).json({ customer_id: newCustomerId, name, email: email || null });
  });
});

// ------------------------------------------------------------------
// Rule 2: Prevent deleting customers
// ------------------------------------------------------------------
apiRouter.delete("/customers/:id", (req, res) => {
  res.status(403).json({ error: "Deleting customers is not allowed" });
});

// (Optional) Get all customers
apiRouter.get("/customers", (req, res) => {
  db.all("SELECT * FROM customers", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// (Optional) Get customer by ID
apiRouter.get("/customers/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM customers WHERE customer_id = ?", [id], (err, customer) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  });
});

// ------------------------------------------------------------------
// Rule 3: List Orders (only orders with total >= $50 are returned)
// ------------------------------------------------------------------
apiRouter.get("/orders", (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;
  const sql = "SELECT * FROM orders WHERE order_amount >= 50 ORDER BY order_date DESC LIMIT ? OFFSET ?";
  db.all(sql, [limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get Order Detail (includes last authorization and settlement)
apiRouter.get("/orders/:id", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM orders WHERE order_id = ?", [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "Order not found" });
    // Fetch last authorization for this order
    db.get(
      "SELECT * FROM authorizations WHERE order_id = ? ORDER BY audit_date DESC LIMIT 1",
      [id],
      (err2, auth) => {
        if (err2) return res.status(500).json({ error: err2.message });
        // Fetch last settlement for this order
        db.get(
          "SELECT * FROM settlements WHERE order_id = ? ORDER BY settlement_date DESC LIMIT 1",
          [id],
          (err3, settlement) => {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({
              order,
              lastAuthorization: auth || null,
              lastSettlement: settlement || null
            });
          }
        );
      }
    );
  });
});

// Checkout / Authorization (creates or updates an order and authorizes payment)
apiRouter.post("/orders/checkout", (req, res) => {
  const { orderId, customerId, amount, last4 } = req.body;
  if (!orderId || !customerId || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const result = pickAuthOutcomeWeighted();  // e.g. "SUCCESS", "INSUFFICIENT_FUNDS", "SERVER_ERROR"
  const status = result === "SUCCESS" 
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
    // Record the authorization attempt
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

// Payment Settlement (settles an authorized payment for an order)
apiRouter.post("/payments/settle", (req, res) => {
  const { orderId, amount } = req.body;
  if (!orderId || !amount) {
    return res.status(400).json({ error: "Missing fields" });
  }
  // Verify order exists and is authorized
  db.get("SELECT order_id, status_id FROM orders WHERE order_id = ?", [orderId], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status_id !== "AUTHORIZED") {
      return res.status(400).json({ error: "Order not authorized, cannot settle" });
    }
    // Get the last authorization record for this order
    db.get(
      "SELECT auth_id FROM authorizations WHERE order_id = ? ORDER BY audit_date DESC LIMIT 1",
      [orderId],
      (err2, auth) => {
        if (err2) return res.status(500).json({ error: err2.message });
        // Insert a new settlement record
        db.run(
          "INSERT INTO settlements(order_id, auth_id, settled_amnt, settlement_stat, settlement_date) VALUES (?, ?, ?, 'SETTLED', datetime('now'))",
          [orderId, auth ? auth.auth_id : null, amount],
          (err3) => {
            if (err3) return res.status(500).json({ error: err3.message });
            // Update order status to SETTLED
            db.run(
              "UPDATE orders SET status_id = 'SETTLED' WHERE order_id = ?",
              [orderId],
              (err4) => {
                if (err4) return res.status(500).json({ error: err4.message });
                res.json({ orderId, paymentStatus: "SETTLED" });
              }
            );
          }
        );
      }
    );
  });
});

// Stats Dashboard (aggregated statistics)
apiRouter.get("/stats", (req, res) => {
  const out = { totals: {}, recentOrders: [], settled_total: 0 };
  // Total counts per status
  db.all(
    "SELECT status_id, COUNT(*) AS count FROM orders GROUP BY status_id",
    [],
    (e1, rows1) => {
      if (e1) return res.status(500).json({ error: e1.message });
      rows1.forEach(r => { out.totals[r.status_id] = r.count; });
      // Total orders count
      db.get("SELECT COUNT(*) AS total FROM orders", [], (e2, row2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        out.totals.ALL = row2 ? row2.total : 0;
        // Sum of all settled amounts
        db.get("SELECT IFNULL(SUM(settled_amnt), 0) AS settled_total FROM settlements", [], (e3, row3) => {
          if (e3) return res.status(500).json({ error: e3.message });
          out.settled_total = Number(row3 ? row3.settled_total : 0);
          // Last 5 orders (most recent)
          db.all(
            "SELECT order_id, customer_id, order_amount, status_id, order_date FROM orders ORDER BY order_date DESC LIMIT 5",
            [],
            (e4, rows4) => {
              if (e4) return res.status(500).json({ error: e4.message });
              out.recentOrders = rows4 || [];
              res.json(out);
            }
          );
        });
      });
    }
  );
});

// ------------------------------------------------------------------
// Rule 5: Simulate payment authorization with static responses
// ------------------------------------------------------------------
apiRouter.post("/authorize", (req, res) => {
  const chance = Math.random();
  const { OrderId, RequestedAmount } = req.body || {};
  if (chance < 0.6) {
    // Success scenario
    let body = successTemplate ? { ...successTemplate } : {};
    body.OrderId = OrderId || body.OrderId || ("ORDER-" + Math.floor(Math.random() * 10000));
    body.AuthorizedAmount = RequestedAmount || body.AuthorizedAmount || 0;
    return res.status(200).json(body);
  } else if (chance < 0.77) {
    // Incorrect card details scenario
    const body = incorrectCardTemplate ? { ...incorrectCardTemplate, OrderId } : { error: "Incorrect card details", OrderId };
    return res.status(400).json(body);
  } else if (chance < 0.94) {
    // Insufficient funds scenario
    const body = insufficientFundsTemplate ? { ...insufficientFundsTemplate, OrderId } : { error: "Insufficient funds", OrderId };
    return res.status(402).json(body);
  } else {
    // Internal server error scenario
    return res.status(500).json(error500Template || { error: "Internal server error" });
  }
});

// Forward to external authorization endpoint (Beeceptor proxy)
import("node-fetch").then(({ default: fetch }) => {
  apiRouter.post("/external-authorize", async (req, res) => {
    try {
      const beeceptorResponse = await fetch(
        "https://capstoneproject.proxy.beeceptor.com/authorize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body)
        }
      );
      const contentType = beeceptorResponse.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await beeceptorResponse.json()
        : await beeceptorResponse.text();
      res.status(beeceptorResponse.status).send(data);
    } catch (err) {
      console.error("Error forwarding to Beeceptor:", err);
      res.status(500).json({ error: "Failed to reach Beeceptor endpoint", details: err.message });
    }
  });
});

// Additional static mock response endpoints
apiRouter.get("/success", (req, res) => {
  res.json(successTemplate || { message: "Payment authorized (success)" });
});
apiRouter.get("/incorrect-card", (req, res) => {
  res.json(incorrectCardTemplate || { error: "Incorrect card details" });
});
apiRouter.get("/insufficient-funds", (req, res) => {
  res.json(insufficientFundsTemplate || { error: "Insufficient funds" });
});
apiRouter.get("/error500", (req, res) => {
  res.status(500).json(error500Template || { error: "Internal server error" });
});

// Mount the API router under /api
app.use("/api", apiRouter);

// ---------- Start the Server ----------
const PORT = process.env.PORT || 3000;
if (!IS_TEST) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

