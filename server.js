require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const express = require("express");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

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
        };
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

app.get("/admin/orders", requireAdmin, (req, res) => {
  let orders = [];
  if (fs.existsSync(ordersPath)) {
    try {
      orders = JSON.parse(fs.readFileSync(ordersPath, "utf-8"));
    } catch (error) {
      orders = [];
    }
  }

  const rows = orders
    .map((order) => {
      const address = order.address
        ? `${order.address.line1 || ""} ${order.address.line2 || ""}, ${order.address.city || ""} - ${
            order.address.state || ""
          }, ${order.address.postal_code || ""}`
        : "Sem endereco";
      const items = order.items
        .map((item) => `${item.quantity}x ${item.description} (R$ ${item.amount.toFixed(2)})`)
        .join("<br/>");
      return `
        <tr>
          <td>${order.id}</td>
          <td>${order.createdAt}</td>
          <td>${order.name || ""}<br/>${order.email || ""}</td>
          <td>${address}</td>
          <td>${items}</td>
          <td>R$ ${order.amount.toFixed(2)}</td>
        </tr>
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
      <table style="width: 100%; border-collapse: collapse; background:#fff;">
        <thead>
          <tr style="background:#7c1414; color:#fff;">
            <th style="padding:12px; text-align:left;">ID</th>
            <th style="padding:12px; text-align:left;">Data</th>
            <th style="padding:12px; text-align:left;">Cliente</th>
            <th style="padding:12px; text-align:left;">Endereco</th>
            <th style="padding:12px; text-align:left;">Itens</th>
            <th style="padding:12px; text-align:left;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td colspan='6' style='padding:12px;'>Nenhum pedido ainda.</td></tr>"}
        </tbody>
      </table>
    `)
  );
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
    const sessionConfig = {
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/success.html`,
      cancel_url: `${baseUrl}/cancel.html`,
      customer_email: req.body.email || undefined,
      shipping_address_collection: {
        allowed_countries: ["BR"],
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
