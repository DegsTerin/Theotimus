require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const crypto = require("crypto");
const { Resend } = require("resend");

const app = express();
const port = process.env.PORT || 4242;
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const resendKey = process.env.RESEND_API_KEY || "";
const resendFrom = process.env.RESEND_FROM || "";
const resendEnabled = Boolean(resendKey && resendFrom);
const resend = resendEnabled ? new Resend(resendKey) : null;
const stripeTaxEnabled = ["true", "1", "yes"].includes(String(process.env.STRIPE_TAX_ENABLED || "").toLowerCase());
const boletoExpiresDays = Number(process.env.BOLETO_EXPIRES_DAYS || 3);
const checkoutPaymentMethodsRaw = String(process.env.CHECKOUT_PAYMENT_METHODS || "").trim();
const crmWebhookUrl = String(process.env.CRM_WEBHOOK_URL || "").trim();
const crmWebhookToken = String(process.env.CRM_WEBHOOK_TOKEN || "").trim();

if (!stripeSecret) {
  console.error("Missing STRIPE_SECRET_KEY in .env");
  process.exit(1);
}

const stripe = Stripe(stripeSecret);

const productsPath = path.join(__dirname, "products.json");
const ordersPath = path.join(__dirname, "orders.json");
const ordersLogPath = path.join(__dirname, "orders.log");
let productsCache = JSON.parse(fs.readFileSync(productsPath, "utf-8"));
const couponCache = new Map();
const cepCache = new Map();

const dbUrl = process.env.DATABASE_URL || "";
const dbEnabled = Boolean(dbUrl);
const pool = dbEnabled
  ? new Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes("render.com")
        ? { rejectUnauthorized: false }
        : false,
    })
  : null;

const initDb = async () => {
  if (!dbEnabled) {
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      amount NUMERIC NOT NULL,
      currency TEXT,
      email TEXT,
      name TEXT,
      phone TEXT,
      address JSONB,
      items JSONB,
      created_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_sessions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS carts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      items JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      last_email_at TIMESTAMPTZ,
      converted BOOLEAN NOT NULL DEFAULT FALSE
    );
  `);
};

const sendEmail = async ({ to, subject, html }) => {
  if (!resendEnabled) {
    return;
  }
  await resend.emails.send({
    from: resendFrom,
    to,
    subject,
    html,
  });
};

const appendOrderLog = (entry) => {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
  fs.appendFile(ordersLogPath, line, () => {});
};

const postJson = (url, payload, headers = {}) =>
  new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === "http:" ? http : https;
      const body = JSON.stringify(payload);
      const req = lib.request(
        {
          method: "POST",
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve(res.statusCode || 200));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (error) {
      reject(error);
    }
  });

const sendOrderToCrm = async (payload) => {
  if (!crmWebhookUrl) {
    return;
  }
  const headers = crmWebhookToken ? { Authorization: `Bearer ${crmWebhookToken}` } : {};
  try {
    await postJson(crmWebhookUrl, payload, headers);
  } catch (error) {
    appendOrderLog({ type: "crm_error", message: error.message || "crm_error" });
  }
};

const saveOrder = async (order) => {
  if (!dbEnabled) {
    let orders = [];
    if (fs.existsSync(ordersPath)) {
      try {
        orders = JSON.parse(fs.readFileSync(ordersPath, "utf-8"));
      } catch (error) {
        orders = [];
      }
    }
    orders.unshift(order);
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
    appendOrderLog({ type: "order_created", order });
    await sendOrderToCrm({ event: "order.created", order });
    return;
  }
  await pool.query(
    `
    INSERT INTO orders (id, amount, currency, email, name, phone, address, items, created_at, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      amount = EXCLUDED.amount,
      currency = EXCLUDED.currency,
      email = EXCLUDED.email,
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      address = EXCLUDED.address,
      items = EXCLUDED.items,
      created_at = EXCLUDED.created_at,
      status = EXCLUDED.status
    `,
    [
      order.id,
      order.amount,
      order.currency,
      order.email,
      order.name,
      order.phone,
      order.address,
      JSON.stringify(order.items || []),
      order.createdAt,
      order.status || "novo",
    ]
  );
  appendOrderLog({ type: "order_created", order });
  await sendOrderToCrm({ event: "order.created", order });
};

const findOrderById = async (id) => {
  if (!dbEnabled) {
    if (!fs.existsSync(ordersPath)) {
      return null;
    }
    try {
      const orders = JSON.parse(fs.readFileSync(ordersPath, "utf-8"));
      return orders.find((order) => order.id === id) || null;
    } catch (error) {
      return null;
    }
  }
  const result = await pool.query(
    "SELECT id, amount, currency, email, name, phone, address, items, created_at, status FROM orders WHERE id = $1",
    [id]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    email: row.email,
    name: row.name,
    phone: row.phone,
    address: row.address,
    items: Array.isArray(row.items) ? row.items : row.items || [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    status: row.status,
  };
};

const listOrders = async () => {
  if (!dbEnabled) {
    if (!fs.existsSync(ordersPath)) {
      return [];
    }
    try {
      return JSON.parse(fs.readFileSync(ordersPath, "utf-8"));
    } catch (error) {
      return [];
    }
  }
  const result = await pool.query(
    "SELECT id, amount, currency, email, name, phone, address, items, created_at, status FROM orders ORDER BY created_at DESC"
  );
  return result.rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    email: row.email,
    name: row.name,
    phone: row.phone,
    address: row.address,
    items: Array.isArray(row.items) ? row.items : row.items || [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    status: row.status,
  }));
};

const escapeCsv = (value) => {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (text.includes(",") || text.includes("\n") || text.includes("\"")) {
    return `"${text.replace(/\"/g, "\"\"")}"`;
  }
  return text;
};

const ordersToCsv = (orders) => {
  const header = [
    "id",
    "created_at",
    "status",
    "amount",
    "currency",
    "email",
    "name",
    "phone",
    "items",
    "address",
  ];
  const rows = orders.map((order) => [
    order.id,
    order.createdAt,
    order.status,
    order.amount,
    order.currency,
    order.email,
    order.name,
    order.phone,
    JSON.stringify(order.items || []),
    JSON.stringify(order.address || {}),
  ]);
  return [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
};

const parseCsv = (content) => {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length);
  if (!lines.length) {
    return [];
  }
  const parseLine = (line) => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current);
    return result.map((value) => value.trim());
  };
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
};

const csvToProducts = (content) => {
  const rows = parseCsv(content);
  const grouped = new Map();
  rows.forEach((row) => {
    const productId = row.product_id || row.id;
    if (!productId) {
      return;
    }
    const existing = grouped.get(productId) || {
      id: productId,
      name: row.product_name || row.name || "",
      description: row.description || "",
      category: row.category || "Geral",
      isNew: ["1", "true", "yes", "sim"].includes(String(row.is_new || row.isnew || "").toLowerCase()),
      bestSeller: ["1", "true", "yes", "sim"].includes(String(row.best_seller || row.bestseller || "").toLowerCase()),
      createdAt: row.created_at || new Date().toISOString().slice(0, 10),
      rating: Number(row.rating || 0) || 0,
      reviewCount: Number(row.review_count || 0) || 0,
      images: row.images ? row.images.split("|").map((img) => img.trim()).filter(Boolean) : [],
      reviews: [],
      variants: [],
    };
    const variantId = row.variant_id || row.variantid;
    if (variantId) {
      existing.variants.push({
        id: variantId,
        size: row.size || "Unico",
        color: row.color || "Padrao",
        material: row.material || "",
        price: Number(row.price || 0),
        stock: Number(row.stock || 0),
      });
    }
    grouped.set(productId, existing);
  });
  return Array.from(grouped.values()).filter((product) => product.variants.length);
};

const updateOrderStatus = async (id, status) => {
  if (!dbEnabled) {
    let orders = [];
    if (fs.existsSync(ordersPath)) {
      try {
        orders = JSON.parse(fs.readFileSync(ordersPath, "utf-8"));
      } catch (error) {
        orders = [];
      }
    }
    const updated = orders.map((order) =>
      order.id === id ? { ...order, status } : order
    );
    fs.writeFileSync(ordersPath, JSON.stringify(updated, null, 2));
    appendOrderLog({ type: "order_status", id, status });
    return;
  }
  await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
  appendOrderLog({ type: "order_status", id, status });
};

const createMagicToken = async (email) => {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30);
  if (dbEnabled) {
    await pool.query(
      "INSERT INTO magic_tokens (token, email, expires_at) VALUES ($1,$2,$3)",
      [token, email, expiresAt.toISOString()]
    );
  }
  return { token, expiresAt };
};

const verifyMagicToken = async (token) => {
  if (!dbEnabled) {
    return null;
  }
  const result = await pool.query(
    "SELECT token, email, expires_at FROM magic_tokens WHERE token = $1",
    [token]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query("DELETE FROM magic_tokens WHERE token = $1", [token]);
    return null;
  }
  await pool.query("DELETE FROM magic_tokens WHERE token = $1", [token]);
  return row.email;
};

const createSession = async (email) => {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  if (dbEnabled) {
    await pool.query(
      "INSERT INTO account_sessions (id, email, expires_at) VALUES ($1,$2,$3)",
      [sessionId, email, expiresAt.toISOString()]
    );
  }
  return { sessionId, expiresAt };
};

const getSessionEmail = async (sessionId) => {
  if (!dbEnabled) {
    return null;
  }
  const result = await pool.query(
    "SELECT email, expires_at FROM account_sessions WHERE id = $1",
    [sessionId]
  );
  if (!result.rows.length) {
    return null;
  }
  const row = result.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query("DELETE FROM account_sessions WHERE id = $1", [sessionId]);
    return null;
  }
  return row.email;
};

const upsertCart = async ({ email, items }) => {
  if (!dbEnabled) {
    return;
  }
  const cartId = crypto.createHash("sha256").update(email).digest("hex");
  await pool.query(
    `
    INSERT INTO carts (id, email, items, updated_at, converted)
    VALUES ($1,$2,$3,$4,false)
    ON CONFLICT (id) DO UPDATE SET
      items = EXCLUDED.items,
      updated_at = EXCLUDED.updated_at
    `,
    [cartId, email, JSON.stringify(items || []), new Date().toISOString()]
  );
};

const markCartConverted = async (email) => {
  if (!dbEnabled) {
    return;
  }
  const cartId = crypto.createHash("sha256").update(email).digest("hex");
  await pool.query("UPDATE carts SET converted = true WHERE id = $1", [cartId]);
};

const coupons = {
  BEMVINDO10: { type: "percent", value: 10 },
  FE5: { type: "amount", value: 5 },
  FRETEGRATIS: { type: "free_shipping", value: 0 },
};

const getProductVariant = (productId, variantId) => {
  const product = productsCache.find((item) => item.id === productId);
  if (!product) {
    return null;
  }
  const variant = product.variants.find((item) => item.id === variantId);
  if (!variant) {
    return null;
  }
  return { product, variant };
};

const sanitizeCep = (cep) => String(cep || "").replace(/\D/g, "");

const fetchCepInfo = (cep) =>
  new Promise((resolve, reject) => {
    const normalized = sanitizeCep(cep);
    if (normalized.length !== 8) {
      reject(new Error("CEP invalido."));
      return;
    }
    const cached = cepCache.get(normalized);
    if (cached) {
      resolve(cached);
      return;
    }
    https
      .get(`https://viacep.com.br/ws/${normalized}/json/`, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const payload = JSON.parse(data);
            if (payload.erro) {
              reject(new Error("CEP nao encontrado."));
              return;
            }
            cepCache.set(normalized, payload);
            resolve(payload);
          } catch (error) {
            reject(new Error("Falha ao consultar CEP."));
          }
        });
      })
      .on("error", () => reject(new Error("Falha ao consultar CEP.")));
  });

const calculateShipping = async (cep, subtotal, coupon) => {
  if (!cep) {
    return { amount: 0, label: "Sem frete", info: null };
  }
  const info = await fetchCepInfo(cep);
  const uf = info.uf;
  let amount = 29.9;
  if (["SP", "RJ", "MG", "ES"].includes(uf)) {
    amount = 19.9;
  } else if (["PR", "SC", "RS"].includes(uf)) {
    amount = 24.9;
  }
  if (subtotal >= 300) {
    amount = 0;
  }
  if (coupon && coupon.type === "free_shipping") {
    amount = 0;
  }
  return { amount, label: `Frete para ${info.uf}`, info };
};

const calculateDiscount = (subtotal, coupon) => {
  if (!coupon) {
    return 0;
  }
  if (coupon.type === "percent") {
    return (subtotal * coupon.value) / 100;
  }
  if (coupon.type === "amount") {
    return Math.min(subtotal, coupon.value);
  }
  return 0;
};

const taxRatesByUf = {
  SP: 0.18,
  RJ: 0.2,
  MG: 0.18,
  ES: 0.17,
  PR: 0.17,
  SC: 0.17,
  RS: 0.17,
};
const defaultTaxRate = Number(process.env.TAX_DEFAULT_RATE || 0.12);

const estimateTaxes = async ({ cepInfo, taxableAmount }) => {
  if (!taxableAmount || taxableAmount <= 0) {
    return { amount: 0, label: "Sem impostos" };
  }
  if (!cepInfo?.uf) {
    const amount = taxableAmount * defaultTaxRate;
    return { amount, label: `Impostos (${Math.round(defaultTaxRate * 100)}%)` };
  }
  const rate = taxRatesByUf[cepInfo.uf] ?? defaultTaxRate;
  const amount = taxableAmount * rate;
  return { amount, label: `Impostos (${Math.round(rate * 100)}%)` };
};

const computeOrder = async ({ items, cep, couponCode }) => {
  const normalizedItems = Array.isArray(items) ? items : [];
  if (normalizedItems.length === 0) {
    throw new Error("Carrinho vazio.");
  }

  let subtotal = 0;
  const lineItems = normalizedItems.map((item) => {
    const quantity = Number(item.quantity);
    if (!item.productId || !item.variantId || Number.isNaN(quantity)) {
      throw new Error("Item invalido no carrinho.");
    }
    const entry = getProductVariant(item.productId, item.variantId);
    if (!entry) {
      throw new Error("Produto ou variacao nao encontrada.");
    }
    if (quantity > entry.variant.stock) {
      throw new Error("Estoque insuficiente.");
    }
    const unitAmount = entry.variant.price;
    subtotal += unitAmount * quantity;
    return {
      price_data: {
        currency: "brl",
        product_data: {
          name: `${entry.product.name} (${entry.variant.size}, ${entry.variant.color}, ${entry.variant.material})`,
        },
        unit_amount: Math.round(unitAmount * 100),
      },
      quantity,
    };
  });

  const normalizedCoupon = couponCode ? couponCode.toUpperCase() : "";
  const coupon = normalizedCoupon ? coupons[normalizedCoupon] : null;
  if (normalizedCoupon && !coupon) {
    throw new Error("Cupom invalido.");
  }
  const shipping = await calculateShipping(cep, subtotal, coupon);
  const discount = calculateDiscount(subtotal, coupon);
  const taxableAmount = Math.max(0, subtotal - discount);
  const taxes = stripeTaxEnabled
    ? { amount: null, label: "Calculado no checkout" }
    : await estimateTaxes({ cepInfo: shipping.info, taxableAmount });

  return { subtotal, lineItems, shipping, discount, coupon, taxes };
};

const emailDisabled = true;

const updateStockFromItems = (items) => {
    if (!Array.isArray(items)) {
      return;
    }
  let updated = false;
  items.forEach((item) => {
    const entry = getProductVariant(item.productId, item.variantId);
    if (!entry) {
      return;
    }
    const qty = Number(item.quantity);
    if (Number.isNaN(qty) || qty <= 0) {
      return;
    }
    entry.variant.stock = Math.max(0, entry.variant.stock - qty);
    updated = true;
  });
  if (updated) {
    fs.writeFileSync(productsPath, JSON.stringify(productsCache, null, 2));
  }
};

const slugify = (text) =>
  String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || `produto-${Date.now()}`;

const saveProducts = () => {
  fs.writeFileSync(productsPath, JSON.stringify(productsCache, null, 2));
};

const toSimpleProduct = (product) => {
  const firstVariant = product.variants?.[0] || {};
  return {
    id: product.id,
    name: product.name,
    price: Number(firstVariant.price ?? product.price ?? 0),
    stock: Number(firstVariant.stock ?? product.stock ?? 0),
    description: product.description || "",
    image: Array.isArray(product.images) ? product.images[0] || "" : product.image || "",
  };
};

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!webhookSecret) {
      return res.status(400).send("Webhook not configured.");
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], webhookSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.metadata?.items) {
        try {
          const items = JSON.parse(session.metadata.items);
          updateStockFromItems(items);
        } catch (error) {
          console.log("Falha ao atualizar estoque.");
        }
      }
      try {
        const expanded = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ["line_items"],
        });
        const order = {
          id: expanded.id,
          amount: expanded.amount_total ? expanded.amount_total / 100 : 0,
          currency: expanded.currency,
          email: expanded.customer_details?.email || expanded.customer_email || null,
          name: expanded.customer_details?.name || null,
          phone: expanded.customer_details?.phone || null,
          address: expanded.customer_details?.address || null,
          items: (expanded.line_items?.data || []).map((item) => ({
            description: item.description,
            quantity: item.quantity,
            amount: item.amount_total ? item.amount_total / 100 : 0,
          })),
          createdAt: new Date().toISOString(),
          status: "novo",
        };
        await saveOrder(order);
        if (order.email) {
          await markCartConverted(order.email);
          if (resendEnabled) {
            await sendEmail({
              to: order.email,
              subject: "Pedido confirmado - Theotimus",
              html: `
                <h2>Pagamento confirmado</h2>
                <p>Obrigado pela sua compra. Seu pedido foi registrado com sucesso.</p>
                <p><strong>ID:</strong> ${order.id}</p>
                <p><strong>Total:</strong> R$ ${order.amount.toFixed(2)}</p>
              `,
            });
          }
        }
      } catch (error) {
        console.error("Falha ao registrar pedido:", error);
      }
      if (emailDisabled) {
        console.log("Email desativado. Use recibos do Stripe.");
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/products", (req, res) => {
  res.json(productsCache);
});

const adminUser = process.env.ADMIN_USER || "";
const adminPass = process.env.ADMIN_PASS || "";

const adminHtml = (body) => `
  <!DOCTYPE html>
  <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Admin - Theotimus</title>
      <style>
        body { font-family: Arial, sans-serif; background:#f5f1eb; color:#2e1b16; padding:24px; }
        .card { max-width: 460px; margin: 80px auto; background:#fff; padding:28px; border-radius:16px; box-shadow: 0 18px 40px rgba(0,0,0,0.08); }
        h1 { margin-bottom: 16px; }
        label { display:block; font-size: 13px; margin: 12px 0 6px; }
        input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid #ccc; }
        button { margin-top: 16px; padding: 10px 18px; border-radius: 999px; border: none; background:#7c1414; color:#fff; cursor: pointer; }
        .error { color: #7c1414; margin-top: 8px; font-size: 13px; }
      </style>
    </head>
    <body>
      ${body}
    </body>
  </html>
`;

const adminPage = ({ title, content }) =>
  adminHtml(`
    <div style="display:flex; gap:20px; align-items:flex-start;">
      <aside style="min-width:180px; background:#fff; padding:18px; border-radius:16px; border:1px solid #eadfd6;">
        <h3 style="margin-bottom:12px;">Admin</h3>
        <nav style="display:grid; gap:10px; font-size:14px;">
          <a href="/admin">Dashboard</a>
          <a href="/admin/orders">Pedidos</a>
          <a href="/admin/products">Produtos</a>
        </nav>
      </aside>
      <main style="flex:1;">
        <div style="display:flex; justify-content: space-between; align-items:center; margin-bottom:16px;">
          <h1 style="margin:0;">${title}</h1>
          <form method="POST" action="/admin/logout">
            <button type="submit">Sair</button>
          </form>
        </div>
        ${content}
      </main>
    </div>
  `);

app.get("/admin/login", (req, res) => {
  const error = req.query.error ? "<div class='error'>Usuario ou senha invalidos.</div>" : "";
  res.send(
    adminHtml(`
      <div class="card">
        <h1>Login Admin</h1>
        <form method="POST" action="/admin/login">
          <label>Usuario</label>
          <input type="text" name="user" required />
          <label>Senha</label>
          <input type="password" name="pass" required />
          <button type="submit">Entrar</button>
          ${error}
        </form>
      </div>
    `)
  );
});

app.post("/admin/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!adminUser || !adminPass) {
    return res.status(403).send("ADMIN_USER/ADMIN_PASS nao configurados.");
  }
  const { user, pass } = req.body;
  if (user === adminUser && pass === adminPass) {
    res.setHeader(
      "Set-Cookie",
      `admin_session=${Buffer.from(`${user}:${pass}`).toString("base64")}; HttpOnly; Path=/; SameSite=Lax`
    );
    return res.redirect("/admin");
  }
  return res.redirect("/admin/login?error=1");
});

const requireAdmin = (req, res, next) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/admin_session=([^;]+)/);
  if (!match) {
    return res.redirect("/admin/login");
  }
  const value = Buffer.from(match[1], "base64").toString("utf-8");
  if (value === `${adminUser}:${adminPass}`) {
    return next();
  }
  return res.redirect("/admin/login");
};

app.get("/products", (req, res) => {
  res.json(productsCache.map(toSimpleProduct));
});

app.post("/products", requireAdmin, (req, res) => {
  const payload = req.body || {};
  const id = String(payload.id || "").trim() || slugify(payload.name);
  if (!payload.name || !id) {
    return res.status(400).json({ ok: false, error: "Dados invalidos." });
  }
  if (productsCache.find((item) => item.id === id)) {
    return res.status(400).json({ ok: false, error: "ID ja existe." });
  }
  const price = Number(payload.price || 0);
  const stock = Number(payload.stock || 0);
  const product = {
    id,
    name: String(payload.name || "").trim(),
    description: String(payload.description || "").trim(),
    images: payload.image ? [String(payload.image).trim()] : [],
    variants: [
      {
        id: `${id}-unico`,
        size: "Unico",
        color: "Padrao",
        material: "",
        price,
        stock,
      },
    ],
  };
  productsCache.unshift(product);
  saveProducts();
  res.json({ ok: true, product: toSimpleProduct(product) });
});

app.put("/products/:id", requireAdmin, (req, res) => {
  const currentId = String(req.params.id || "");
  const payload = req.body || {};
  const nextId = String(payload.id || currentId).trim();
  const index = productsCache.findIndex((item) => item.id === currentId);
  if (index === -1) {
    return res.status(404).json({ ok: false, error: "Produto nao encontrado." });
  }
  if (nextId !== currentId && productsCache.some((item) => item.id === nextId)) {
    return res.status(400).json({ ok: false, error: "ID ja existe." });
  }
  const product = { ...productsCache[index] };
  product.id = nextId;
  product.name = String(payload.name || product.name || "").trim();
  product.description = String(payload.description || product.description || "").trim();
  if (payload.image !== undefined) {
    const image = String(payload.image || "").trim();
    product.images = image ? [image] : [];
  }
  const price = Number(payload.price ?? product.variants?.[0]?.price ?? product.price ?? 0);
  const stock = Number(payload.stock ?? product.variants?.[0]?.stock ?? product.stock ?? 0);
  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    product.variants = [
      { id: `${product.id}-unico`, size: "Unico", color: "Padrao", material: "", price, stock },
    ];
  } else {
    product.variants = product.variants.map((variant) => ({ ...variant, price, stock }));
  }
  productsCache[index] = product;
  saveProducts();
  res.json({ ok: true, product: toSimpleProduct(product) });
});

app.delete("/products/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const next = productsCache.filter((item) => item.id !== id);
  if (next.length === productsCache.length) {
    return res.status(404).json({ ok: false, error: "Produto nao encontrado." });
  }
  productsCache = next;
  saveProducts();
  res.json({ ok: true });
});

app.post("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, (req, res) => {
  res.send(
    adminPage({
      title: "Dashboard",
      content: `
        <div style="display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));">
          <div class="card" style="padding:18px; margin:0;">
            <h3>Pedidos</h3>
            <p>Veja e atualize status dos pedidos recebidos.</p>
            <a href="/admin/orders">Ir para pedidos</a>
          </div>
          <div class="card" style="padding:18px; margin:0;">
            <h3>Produtos</h3>
            <p>Cadastre, edite e gerencie estoque.</p>
            <a href="/admin/products">Ir para produtos</a>
          </div>
        </div>
      `,
    })
  );
});

app.post("/admin/orders/update", requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res.redirect("/admin/orders");
  }
  const allowed = ["novo", "pagamento", "separacao", "enviado", "entregue", "problema", "cancelado"];
  const safeStatus = allowed.includes(status) ? status : "novo";
  updateOrderStatus(id, safeStatus)
    .then(async () => {
      const order = await findOrderById(id);
      if (order && order.email && resendEnabled) {
        const subject =
          safeStatus === "enviado"
            ? "Pedido enviado - Theotimus"
            : safeStatus === "entregue"
            ? "Pedido entregue - Theotimus"
            : safeStatus === "problema"
            ? "Ação necessária no pedido - Theotimus"
            : "Atualização do pedido - Theotimus";
        await sendEmail({
          to: order.email,
          subject,
          html: `
            <h2>Status atualizado</h2>
            <p>Seu pedido <strong>${order.id}</strong> agora está em: <strong>${safeStatus}</strong>.</p>
            <p>Total: R$ ${order.amount.toFixed(2)}</p>
          `,
        });
      }
      if (order) {
        await sendOrderToCrm({ event: "order.status_updated", order });
      }
    })
    .catch(() => {});
  return res.redirect("/admin/orders");
});

app.post("/admin/orders/update-json", requireAdmin, express.json(), (req, res) => {
  const { id, status } = req.body || {};
  if (!id || !status) {
    return res.status(400).json({ ok: false });
  }
  const allowed = ["novo", "pagamento", "separacao", "enviado", "entregue", "problema", "cancelado"];
  const safeStatus = allowed.includes(status) ? status : "novo";
  updateOrderStatus(id, safeStatus)
    .then(async () => {
      const order = await findOrderById(id);
      if (order && order.email && resendEnabled) {
        const subject =
          safeStatus === "enviado"
            ? "Pedido enviado - Theotimus"
            : safeStatus === "entregue"
            ? "Pedido entregue - Theotimus"
            : safeStatus === "problema"
            ? "Ação necessária no pedido - Theotimus"
            : "Atualização do pedido - Theotimus";
        await sendEmail({
          to: order.email,
          subject,
          html: `
            <h2>Status atualizado</h2>
            <p>Seu pedido <strong>${order.id}</strong> agora está em: <strong>${safeStatus}</strong>.</p>
            <p>Total: R$ ${order.amount.toFixed(2)}</p>
          `,
        });
      }
      if (order) {
        await sendOrderToCrm({ event: "order.status_updated", order });
      }
      res.json({ ok: true });
    })
    .catch(() => res.status(500).json({ ok: false }));
});

app.get("/admin/orders.csv", requireAdmin, async (req, res) => {
  try {
    const orders = await listOrders();
    const csv = ordersToCsv(orders);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"orders.csv\"");
    res.send(csv);
  } catch (error) {
    res.status(500).send("Falha ao exportar CSV.");
  }
});

app.get("/admin/orders/logs", requireAdmin, (req, res) => {
  if (!fs.existsSync(ordersLogPath)) {
    return res.send("Sem logs.");
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(fs.readFileSync(ordersLogPath, "utf-8"));
});

app.get("/admin/products", requireAdmin, (req, res) => {
  const rows = productsCache
    .map((product) => {
      const firstVariant = product.variants?.[0] || {};
      const price = typeof firstVariant.price === "number" ? firstVariant.price : product.price || 0;
      const stock =
        typeof firstVariant.stock === "number"
          ? firstVariant.stock
          : product.stock || 0;
      const image = Array.isArray(product.images) ? product.images[0] : product.image || "";
      const safeDescription = String(product.description || "").replace(/"/g, "&quot;");
      return `
        <tr data-id="${product.id}" data-description="${safeDescription}">
          <td>${product.id}</td>
          <td>${product.name}</td>
          <td>R$ ${Number(price).toFixed(2)}</td>
          <td>${Number(stock)}</td>
          <td><img src="${image}" alt="${product.name}" style="width:48px; height:36px; object-fit:cover; border-radius:8px;" /></td>
          <td>
            <button type="button" data-edit="${product.id}">Editar</button>
            <button type="button" data-delete="${product.id}">Excluir</button>
          </td>
        </tr>
      `;
    })
    .join("");

  res.send(
    adminPage({
      title: "Produtos",
      content: `
        <div style="display:grid; gap:18px;">
          <div class="card" style="max-width:none; margin:0; padding:20px;">
            <h3>Adicionar / Editar</h3>
            <form id="productForm" style="display:grid; gap:12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
              <input type="hidden" name="originalId" />
              <label>Id<input name="id" required /></label>
              <label>Nome<input name="name" required /></label>
              <label>Preco<input name="price" type="number" step="0.01" required /></label>
              <label>Estoque<input name="stock" type="number" step="1" required /></label>
              <label>Imagem (URL)<input name="image" /></label>
              <label style="grid-column: 1 / -1;">Descricao<textarea name="description" rows="3" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid #ccc; font-family: inherit;"></textarea></label>
              <div style="grid-column: 1 / -1; display:flex; gap:10px; align-items:center;">
                <button type="submit">Salvar</button>
                <button type="button" id="resetForm">Novo produto</button>
                <a href="/admin/products/import">Importar via JSON/CSV</a>
              </div>
            </form>
          </div>

          <div class="card" style="max-width:none; margin:0; padding:20px;">
            <h3>Lista de produtos</h3>
            <table style="width:100%; border-collapse: collapse;">
              <thead>
                <tr style="text-align:left; font-size:13px; color:#7c6a62;">
                  <th>ID</th>
                  <th>Nome</th>
                  <th>Preco</th>
                  <th>Estoque</th>
                  <th>Imagem</th>
                  <th>Acoes</th>
                </tr>
              </thead>
              <tbody>
                ${rows || "<tr><td colspan='6' style='padding:12px;'>Sem produtos.</td></tr>"}
              </tbody>
            </table>
          </div>
        </div>
        <script>
          const form = document.getElementById("productForm");
          const resetBtn = document.getElementById("resetForm");

          const fillForm = (row) => {
            const id = row.getAttribute("data-id");
            const cells = row.querySelectorAll("td");
            form.originalId.value = id;
            form.id.value = id;
            form.name.value = cells[1].innerText.trim();
            form.price.value = Number(cells[2].innerText.replace("R$", "").trim().replace(",", "."));
            form.stock.value = Number(cells[3].innerText.trim());
            const img = row.querySelector("img");
            form.image.value = img ? img.getAttribute("src") : "";
            form.description.value = row.getAttribute("data-description") || "";
          };

          document.querySelectorAll("[data-edit]").forEach((btn) => {
            btn.addEventListener("click", () => {
              const row = btn.closest("tr");
              if (row) fillForm(row);
            });
          });

          document.querySelectorAll("[data-delete]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              const id = btn.getAttribute("data-delete");
              if (!id || !confirm("Excluir produto?")) return;
              await fetch(\`/products/\${id}\`, { method: "DELETE" });
              location.reload();
            });
          });

          resetBtn.addEventListener("click", () => {
            form.reset();
            form.originalId.value = "";
          });

          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const payload = {
              id: form.id.value.trim(),
              name: form.name.value.trim(),
              price: Number(form.price.value),
              stock: Number(form.stock.value),
              description: form.description.value.trim(),
              image: form.image.value.trim(),
              originalId: form.originalId.value.trim() || undefined,
            };
            const method = payload.originalId ? "PUT" : "POST";
            const url = payload.originalId ? \`/products/\${payload.originalId}\` : "/products";
            const response = await fetch(url, {
              method,
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              alert("Falha ao salvar produto.");
              return;
            }
            location.reload();
          });
        </script>
      `,
    })
  );
});

app.get("/admin/products/import", requireAdmin, (req, res) => {
  const error = req.query.error ? "<div class='error'>Falha ao atualizar produtos.</div>" : "";
  const success = req.query.success ? "<div class='success'>Produtos atualizados.</div>" : "";
  res.send(
    adminPage({
      title: "Importar produtos",
      content: `
        <div class="card" style="max-width:760px; margin:0;">
          <p>Edite via JSON ou CSV (uma linha por variante).</p>
          ${error}
          ${success}
          <form method="POST" action="/admin/products/import">
            <label>Formato</label>
            <select name="format" style="width:100%; padding:10px 12px; border-radius:10px; border:1px solid #ccc;">
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
            <label>Conteudo</label>
            <textarea name="payload" rows="18" style="width:100%; padding:12px; border-radius:12px; border:1px solid #ccc; font-family: monospace;"></textarea>
            <button type="submit">Salvar</button>
          </form>
          <div style="margin-top:18px; font-size:13px; color:#7c6a62;">
            <strong>CSV esperado:</strong> product_id,product_name,description,category,is_new,best_seller,created_at,review_count,rating,images,variant_id,size,color,material,price,stock
          </div>
          <div style="margin-top:12px;">
            <a href="/admin/products.csv">Baixar CSV</a> · <a href="/admin/products.json">Baixar JSON</a>
          </div>
        </div>
        <style>
          .success { color:#2b7a2b; margin-top:8px; font-size:13px; }
        </style>
      `,
    })
  );
});

app.get("/admin/products.json", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"products.json\"");
  res.send(JSON.stringify(productsCache, null, 2));
});

app.get("/admin/products.csv", requireAdmin, (req, res) => {
  const header = [
    "product_id",
    "product_name",
    "description",
    "category",
    "is_new",
    "best_seller",
    "created_at",
    "review_count",
    "rating",
    "images",
    "variant_id",
    "size",
    "color",
    "material",
    "price",
    "stock",
  ];
  const rows = [];
  productsCache.forEach((product) => {
    product.variants.forEach((variant) => {
      rows.push([
        product.id,
        product.name,
        product.description,
        product.category || "",
        product.isNew ? "true" : "false",
        product.bestSeller ? "true" : "false",
        product.createdAt || "",
        product.reviewCount || 0,
        product.rating || 0,
        Array.isArray(product.images) ? product.images.join("|") : "",
        variant.id,
        variant.size,
        variant.color,
        variant.material,
        variant.price,
        variant.stock,
      ]);
    });
  });
  const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"products.csv\"");
  res.send(csv);
});

app.post(
  "/admin/products/import",
  requireAdmin,
  express.urlencoded({ extended: false, limit: "2mb" }),
  (req, res) => {
    try {
      const format = String(req.body.format || "json").toLowerCase();
      const payload = String(req.body.payload || "");
      if (!payload.trim()) {
        return res.redirect("/admin/products/import?error=1");
      }
      let nextProducts = [];
      if (format === "csv") {
        nextProducts = csvToProducts(payload);
      } else {
        const parsed = JSON.parse(payload);
        nextProducts = Array.isArray(parsed) ? parsed : [];
      }
      if (!Array.isArray(nextProducts) || nextProducts.length === 0) {
        return res.redirect("/admin/products/import?error=1");
      }
      productsCache = nextProducts;
      fs.writeFileSync(productsPath, JSON.stringify(productsCache, null, 2));
      res.redirect("/admin/products/import?success=1");
    } catch (error) {
      res.redirect("/admin/products/import?error=1");
    }
  }
);

app.get("/admin/orders", requireAdmin, (req, res) => {
  const renderOrders = (orders) => {

  const statusColumns = [
    { key: "novo", label: "Novo" },
    { key: "pagamento", label: "Pagamento confirmado" },
    { key: "separacao", label: "Separacao" },
    { key: "enviado", label: "Enviado" },
    { key: "entregue", label: "Entregue" },
    { key: "problema", label: "Problema" },
    { key: "cancelado", label: "Cancelado" },
  ];

  const buildCard = (order) => {
    const address = order.address
      ? `${order.address.line1 || ""} ${order.address.line2 || ""}, ${order.address.city || ""} - ${
          order.address.state || ""
        }, ${order.address.postal_code || ""}`
      : "Sem endereco";
    const items = order.items
      .map((item) => `${item.quantity}x ${item.description} (R$ ${item.amount.toFixed(2)})`)
      .join("<br/>");
    return `
      <div class="card" draggable="true" data-order-id="${order.id}">
        <div class="card-title">${order.name || "Cliente"} <span class="muted">(${order.email || "sem email"})</span></div>
        <div class="muted">${order.createdAt}</div>
        <div class="card-section"><strong>Endereco:</strong> ${address}</div>
        <div class="card-section"><strong>Itens:</strong><br/>${items}</div>
        <div class="card-section"><strong>Total:</strong> R$ ${order.amount.toFixed(2)}</div>
        <div class="card-actions">
          <button type="button" data-move="prev">Voltar</button>
          <button type="button" data-move="next">Avancar</button>
        </div>
      </div>
    `;
  };

  const boards = statusColumns
    .map((col) => {
      const colOrders = orders.filter((order) => (order.status || "novo") === col.key);
      return `
        <div class="column" data-status="${col.key}">
          <div class="column-header">
            <span>${col.label}</span>
            <span class="count">${colOrders.length}</span>
          </div>
          <div class="column-body" data-status="${col.key}">
            ${colOrders.map(buildCard).join("") || "<div class='empty'>Sem pedidos</div>"}
          </div>
        </div>
      `;
    })
    .join("");

  res.send(
    adminPage({
      title: "Pedidos recebidos",
      content: `
        <div style="margin: 12px 0 18px; display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <input id="orderFilter" type="text" placeholder="Buscar por cliente, email ou ID" style="padding:10px 12px; border-radius:10px; border:1px solid #ccc; min-width: 280px;" />
          <a href="/admin/orders.csv">Exportar CSV</a>
          <a href="/admin/orders/logs">Ver logs</a>
        </div>
        <div class="board">
          ${boards}
        </div>
        <style>
          .board { display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
          .column { background:#fff; border-radius:14px; padding:12px; min-height: 240px; border: 1px solid #eadfd6; }
          .column-header { display:flex; justify-content: space-between; align-items:center; font-weight:700; margin-bottom:12px; color:#4a2a22; }
          .count { background:#7c1414; color:#fff; font-size:12px; padding:2px 8px; border-radius:999px; }
          .column-body { min-height: 160px; display:flex; flex-direction:column; gap:10px; }
          .card { background:#fdf9f5; border-radius:12px; padding:10px; border:1px solid #eadfd6; cursor: grab; }
          .card-title { font-weight:700; margin-bottom:4px; }
          .card-section { margin-top:6px; font-size:13px; }
          .card-actions { display:flex; gap:8px; margin-top:10px; }
          .card-actions button { padding:6px 10px; border-radius:999px; border:1px solid #7c1414; background:#fff; color:#7c1414; cursor:pointer; font-size:12px; }
          .muted { color:#7c6a62; font-size:12px; }
          .empty { color:#9a8d84; font-size:12px; padding:8px; }
          .column-body.drag-over { outline: 2px dashed #7c1414; outline-offset: 4px; }
        </style>
        <script>
        const statusFlow = ["novo","pagamento","separacao","enviado","entregue","problema","cancelado"];
        const filterInput = document.getElementById("orderFilter");
        const cards = Array.from(document.querySelectorAll(".card"));
        const columns = Array.from(document.querySelectorAll(".column-body"));

        const updateStatus = async (id, status) => {
          await fetch("/admin/orders/update-json", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status }),
          });
          location.reload();
        };

        filterInput?.addEventListener("input", () => {
          const query = filterInput.value.toLowerCase().trim();
          cards.forEach((card) => {
            const text = card.innerText.toLowerCase();
            card.style.display = text.includes(query) ? "" : "none";
          });
        });

        cards.forEach((card) => {
          card.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", card.dataset.orderId);
          });
          card.querySelectorAll("[data-move]").forEach((btn) => {
            btn.addEventListener("click", () => {
              const currentCol = card.closest(".column-body");
              const currentStatus = currentCol?.dataset.status || "novo";
              const index = statusFlow.indexOf(currentStatus);
              const direction = btn.dataset.move === "next" ? 1 : -1;
              const nextStatus = statusFlow[index + direction];
              if (nextStatus) {
                updateStatus(card.dataset.orderId, nextStatus);
              }
            });
          });
        });

        columns.forEach((col) => {
          col.addEventListener("dragover", (e) => {
            e.preventDefault();
            col.classList.add("drag-over");
          });
          col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
          col.addEventListener("drop", (e) => {
            e.preventDefault();
            col.classList.remove("drag-over");
            const id = e.dataTransfer.getData("text/plain");
            const status = col.dataset.status;
            if (id && status) {
              updateStatus(id, status);
            }
          });
        });
        </script>
      `,
    })
  );
  };

  listOrders()
    .then(renderOrders)
    .catch(() => renderOrders([]));
});

app.get("/account/login", (req, res) => {
  res.send(
    adminHtml(`
      <div class="card">
        <h1>Minha conta</h1>
        <p>Receba um link mágico no seu e-mail para acessar seus pedidos.</p>
        <form method="POST" action="/account/login">
          <label>E-mail</label>
          <input type="email" name="email" required />
          <button type="submit">Enviar link</button>
        </form>
      </div>
    `)
  );
});

app.post("/account/login", express.urlencoded({ extended: false }), async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) {
    return res.redirect("/account/login");
  }
  if (!resendEnabled) {
    return res.send("Email nao configurado.");
  }
  const { token } = await createMagicToken(email);
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const link = `${baseUrl}/account/verify?token=${token}`;
  await sendEmail({
    to: email,
    subject: "Seu link de acesso - Theotimus",
    html: `
      <h2>Seu link de acesso</h2>
      <p>Clique para acessar seus pedidos:</p>
      <p><a href="${link}">Acessar minha conta</a></p>
      <p>Este link expira em 30 minutos.</p>
    `,
  });
  res.send(
    adminHtml(`
      <div class="card">
        <h1>Verifique seu e-mail</h1>
        <p>Enviamos um link de acesso para ${email}.</p>
      </div>
    `)
  );
});

app.get("/account/verify", async (req, res) => {
  const token = String(req.query.token || "");
  const email = await verifyMagicToken(token);
  if (!email) {
    return res.send(
      adminHtml(`
        <div class="card">
          <h1>Link invalido</h1>
          <p>Solicite um novo link.</p>
        </div>
      `)
    );
  }
  const session = await createSession(email);
  res.setHeader(
    "Set-Cookie",
    `account_session=${session.sessionId}; HttpOnly; Path=/; SameSite=Lax`
  );
  return res.redirect("/account/orders");
});

const requireAccount = async (req, res, next) => {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/account_session=([^;]+)/);
  if (!match) {
    return res.redirect("/account/login");
  }
  const email = await getSessionEmail(match[1]);
  if (!email) {
    return res.redirect("/account/login");
  }
  req.accountEmail = email;
  return next();
};

app.post("/account/logout", (req, res) => {
  res.setHeader("Set-Cookie", "account_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.redirect("/account/login");
});

app.get("/account/orders", requireAccount, async (req, res) => {
  const email = req.accountEmail;
  const orders = await listOrders();
  const rows = orders
    .filter((order) => order.email === email)
    .map((order) => {
      const items = (order.items || [])
        .map((item) => `${item.quantity}x ${item.description} (R$ ${item.amount.toFixed(2)})`)
        .join("<br/>");
      return `
        <tr>
          <td>${order.id}</td>
          <td>${order.createdAt}</td>
          <td>${order.status || "novo"}</td>
          <td>${items}</td>
          <td>R$ ${order.amount.toFixed(2)}</td>
        </tr>
      `;
    })
    .join("");

  res.send(
    adminHtml(`
      <div style="display:flex; justify-content: space-between; align-items:center;">
        <h1>Meus pedidos</h1>
        <form method="POST" action="/account/logout">
          <button type="submit">Sair</button>
        </form>
      </div>
      <table style="width: 100%; border-collapse: collapse; background:#fff;">
        <thead>
          <tr style="background:#7c1414; color:#fff;">
            <th style="padding:12px; text-align:left;">ID</th>
            <th style="padding:12px; text-align:left;">Data</th>
            <th style="padding:12px; text-align:left;">Status</th>
            <th style="padding:12px; text-align:left;">Itens</th>
            <th style="padding:12px; text-align:left;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='5' style='padding:12px;'>Nenhum pedido ainda.</td></tr>"}
        </tbody>
      </table>
    `)
  );
});

app.post("/api/cart/track", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!email || items.length === 0) {
    return res.json({ ok: true });
  }
  await upsertCart({ email, items });
  res.json({ ok: true });
});

app.post("/api/quote", async (req, res) => {
  try {
    const result = await computeOrder({
      items: req.body.items,
      cep: req.body.cep,
      couponCode: req.body.coupon,
    });
    res.json({
      subtotal: result.subtotal,
      shipping: result.shipping.amount,
      discount: result.discount,
      tax: result.taxes.amount,
      taxLabel: result.taxes.label,
    });
  } catch (error) {
    res.status(400).json({ error: error.message || "Erro ao calcular." });
  }
});

app.post("/create-checkout-session", async (req, res) => {
  try {

    console.log("Checkout request received", {
      itemsCount: Array.isArray(req.body.items) ? req.body.items.length : 0,
      hasEmail: Boolean(req.body.email),
    });

    if (!req.body.email) {
      return res.status(400).json({ error: "Informe um e-mail para continuar." });
    }

    const { lineItems, shipping, discount, coupon, taxes } = await computeOrder({
      items: req.body.items,
      cep: req.body.cep,
      couponCode: req.body.coupon,
    });

    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;

    const allowedLocales = ["pt-BR", "en-GB"];
    const locale = allowedLocales.includes(req.body.locale)
      ? req.body.locale
      : "auto";

    const countriesEnv =
      process.env.SHIPPING_COUNTRIES ||
      "BR,US,GB,IE,DE,FR,ES,IT,NL,BE,PT,CA,AU,JP";

    const allowedCountries = countriesEnv
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    if (!stripeTaxEnabled && typeof taxes.amount === "number" && taxes.amount > 0) {
      lineItems.push({
        price_data: {
          currency: "brl",
          product_data: { name: taxes.label || "Taxas e impostos" },
          unit_amount: Math.round(taxes.amount * 100),
        },
        quantity: 1,
      });
    }

    const sessionConfig = {

      mode: "payment",

      line_items: lineItems,

      success_url: `${baseUrl}/success.html`,

      cancel_url: `${baseUrl}/cancel.html`,

      customer_email: req.body.email || undefined,

      locale,

      payment_method_types: ["card", "pix"],

      shipping_address_collection: {
        allowed_countries: allowedCountries,
      },

      metadata: {
        items: JSON.stringify(
          (req.body.items || []).map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          }))
        ),
      },

      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: Math.round(shipping.amount * 100),
              currency: "brl",
            },
            display_name: shipping.label,
          },
        },
      ],
    };

    if (stripeTaxEnabled) {
      sessionConfig.automatic_tax = { enabled: true };
      sessionConfig.customer_creation = "always";
      sessionConfig.customer_update = {
        address: "auto",
        shipping: "auto",
      };
    }

    if (coupon && discount > 0 && coupon.type !== "free_shipping") {

      const couponKey =
        coupon.type === "amount"
          ? `amount:${Math.round(discount * 100)}`
          : `percent:${coupon.value}`;

      let stripeCouponId = couponCache.get(couponKey);

      if (!stripeCouponId) {

        const stripeCoupon = await stripe.coupons.create({
          duration: "once",
          percent_off: coupon.type === "percent" ? coupon.value : undefined,
          amount_off:
            coupon.type === "amount" ? Math.round(discount * 100) : undefined,
          currency: coupon.type === "amount" ? "brl" : undefined,
          name: `Cupom ${coupon.type}`,
        });

        stripeCouponId = stripeCoupon.id;

        couponCache.set(couponKey, stripeCouponId);
      }

      sessionConfig.discounts = [{ coupon: stripeCouponId }];
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    return res.json({ url: session.url });

  } catch (error) {

    console.error("Checkout error:", error);

    return res.status(500).json({
      error: error.message || "Erro no checkout.",
    });

  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

initDb().catch((error) => {
  console.error("Falha ao iniciar banco:", error);
});

const runAbandonedCartJob = async () => {
  if (!dbEnabled || !resendEnabled) {
    return;
  }
  const cutoff = new Date(Date.now() - 1000 * 60 * 60);
  const result = await pool.query(
    `
    SELECT id, email, items, updated_at, last_email_at
    FROM carts
    WHERE converted = false
      AND updated_at < $1
      AND (last_email_at IS NULL OR last_email_at < $2)
    LIMIT 20
    `,
    [cutoff.toISOString(), cutoff.toISOString()]
  );
  for (const row of result.rows) {
    await sendEmail({
      to: row.email,
      subject: "Você deixou itens no carrinho - Theotimus",
      html: `
        <h2>Seu carrinho está esperando</h2>
        <p>Você deixou alguns itens no carrinho. Finalize sua compra quando quiser.</p>
      `,
    });
    await pool.query("UPDATE carts SET last_email_at = $1 WHERE id = $2", [
      new Date().toISOString(),
      row.id,
    ]);
  }
};

setInterval(() => {
  runAbandonedCartJob().catch(() => {});
}, 1000 * 60 * 15);
