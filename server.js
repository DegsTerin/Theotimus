require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 4242;
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecret) {
  console.error("Missing STRIPE_SECRET_KEY in .env");
  process.exit(1);
}

const stripe = Stripe(stripeSecret);

const productsPath = path.join(__dirname, "products.json");
const ordersPath = path.join(__dirname, "orders.json");
let productsCache = JSON.parse(fs.readFileSync(productsPath, "utf-8"));
const couponCache = new Map();

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
    return;
  }
  await pool.query("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
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
    return { amount: 0, label: "Sem frete" };
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
  return { amount, label: `Frete para ${info.uf}` };
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

  return { subtotal, lineItems, shipping, discount, coupon };
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
    return res.redirect("/admin/orders");
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

app.post("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  res.redirect("/admin/login");
});

app.post("/admin/orders/update", requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const { id, status } = req.body;
  if (!id || !status) {
    return res.redirect("/admin/orders");
  }
  const allowed = ["novo", "pagamento", "separacao", "enviado", "entregue", "problema", "cancelado"];
  const safeStatus = allowed.includes(status) ? status : "novo";
  updateOrderStatus(id, safeStatus).catch(() => {});
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
    .then(() => res.json({ ok: true }))
    .catch(() => res.status(500).json({ ok: false }));
});

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
    adminHtml(`
      <div style="display:flex; justify-content: space-between; align-items:center;">
        <h1>Pedidos recebidos</h1>
        <form method="POST" action="/admin/logout">
          <button type="submit">Sair</button>
        </form>
      </div>
      <div style="margin: 12px 0 18px; display:flex; gap:12px; flex-wrap:wrap;">
        <input id="orderFilter" type="text" placeholder="Buscar por cliente, email ou ID" style="padding:10px 12px; border-radius:10px; border:1px solid #ccc; min-width: 280px;" />
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
    `)
  );
  };

  listOrders()
    .then(renderOrders)
    .catch(() => renderOrders([]));
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
    const { lineItems, shipping, discount, coupon } = await computeOrder({
      items: req.body.items,
      cep: req.body.cep,
      couponCode: req.body.coupon,
    });

    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
    const allowedLocales = ["pt-BR", "en-GB"];
    const locale = allowedLocales.includes(req.body.locale) ? req.body.locale : "auto";
    const countriesEnv = process.env.SHIPPING_COUNTRIES || "BR,US,GB,IE,DE,FR,ES,IT,NL,BE,PT,CA,AU,JP";
    const allowedCountries = countriesEnv.split(",").map((c) => c.trim()).filter(Boolean);

    const sessionConfig = {
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/success.html`,
      cancel_url: `${baseUrl}/cancel.html`,
      customer_email: req.body.email || undefined,
      locale,
      automatic_payment_methods: { enabled: true },
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
            fixed_amount: { amount: Math.round(shipping.amount * 100), currency: "brl" },
            display_name: shipping.label,
          },
        },
      ],
    };

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
          amount_off: coupon.type === "amount" ? Math.round(discount * 100) : undefined,
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
    return res.status(500).json({ error: error.message || "Erro no checkout." });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

initDb().catch((error) => {
  console.error("Falha ao iniciar banco:", error);
});
