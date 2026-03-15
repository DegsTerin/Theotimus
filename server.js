require("dotenv").config();
const express = require("express");
const Stripe = require("stripe");

const app = express();
const port = process.env.PORT || 4242;
const stripeSecret = process.env.STRIPE_SECRET_KEY;

if (!stripeSecret) {
  console.error("Missing STRIPE_SECRET_KEY in .env");
  process.exit(1);
}

const stripe = Stripe(stripeSecret);

app.use(express.json());
app.use(express.static(__dirname));

app.post("/create-checkout-session", async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ error: "Carrinho vazio." });
    }

    const lineItems = items.map((item) => {
      const price = Number(item.price);
      const quantity = Number(item.quantity);
      if (!item.name || Number.isNaN(price) || Number.isNaN(quantity)) {
        throw new Error("Item invalido no carrinho.");
      }
      return {
        price_data: {
          currency: "brl",
          product_data: { name: item.name },
          unit_amount: Math.round(price * 100),
        },
        quantity,
      };
    });

    const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${baseUrl}/success.html`,
      cancel_url: `${baseUrl}/cancel.html`,
    });

    return res.json({ url: session.url });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Erro no checkout." });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
