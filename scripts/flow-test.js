require("dotenv").config();
const { chromium } = require("playwright");

const BASE_URL = process.env.TEST_BASE_URL || "https://theotimus.onrender.com/";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "";

const timeout = 30000;

const sendResendEmail = async (subject, text) => {
  if (!RESEND_API_KEY || !RESEND_FROM || !ALERT_EMAIL) {
    return { sent: false, reason: "Resend not configured" };
  }
  const payload = {
    from: RESEND_FROM,
    to: ALERT_EMAIL,
    subject,
    html: `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; white-space: pre-wrap;">${text}</pre>`,
  };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend failed: ${response.status} ${body}`);
  }
  return { sent: true };
};

const main = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  const steps = [];

  const record = (label) => steps.push(`[OK] ${label}`);
  const fail = (label, err) => {
    const msg = err && err.message ? err.message : String(err || "Unknown error");
    steps.push(`[FAIL] ${label}: ${msg}`);
    errors.push(`${label}: ${msg}`);
  };

  page.on("pageerror", (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`console: ${msg.text()}`);
    }
  });

  const ensureCartOpen = async () => {
    const drawer = page.locator(".cart-drawer");
    const isOpen = await drawer.evaluate((el) => el.classList.contains("open")).catch(() => false);
    if (!isOpen) {
      await page.click(".cart-button");
    }
    await page.waitForSelector(".cart-drawer.open", { timeout });
  };

  const closeModalIfOpen = async () => {
    const modalOpen = await page.locator(".modal.open").count();
    if (modalOpen > 0) {
      await page.click("[data-modal-close]");
      await page.waitForTimeout(500);
    }
  };

  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout });
    await page.waitForSelector(".site-header", { timeout });
    record("Home loaded");
  } catch (err) {
    fail("Home loaded", err);
  }

  try {
    await page.waitForSelector(".collection-grid", { timeout });
    await page.waitForTimeout(1500);
    const addButtons = await page.locator(".add-to-cart").all();
    if (addButtons.length === 0) throw new Error("No add-to-cart buttons found");
    await addButtons[0].click();
    record("Add to cart");
  } catch (err) {
    fail("Add to cart", err);
  }

  try {
    await ensureCartOpen();
    await page.fill("[data-email-input]", "cliente@teste.com");
    await page.fill("[data-cep-input]", "01001-000");
    await page.click("[data-quote]");
    await page.waitForTimeout(1500);
    record("Quote shipping/tax");
  } catch (err) {
    fail("Quote shipping/tax", err);
  }

  try {
    await ensureCartOpen();
    await page.locator("[data-checkout]").scrollIntoViewIfNeeded();
    await closeModalIfOpen();
    await page.click("[data-checkout]");
    await page.waitForTimeout(4000);
    const modal = page.locator(".modal.open");
    if (await modal.count()) {
      const message = await page.locator("[data-modal-message]").innerText().catch(() => "");
      throw new Error(message ? `Checkout modal: ${message}` : "Checkout modal error opened");
    }
    record("Checkout initiated");
  } catch (err) {
    fail("Checkout initiated", err);
  }

  try {
    await page.goto(`${BASE_URL}account/login`, { waitUntil: "domcontentloaded", timeout });
    await page.waitForSelector("form[action='/account/login']", { timeout });
    record("Account login page");
  } catch (err) {
    fail("Account login page", err);
  }

  try {
    await page.goto(`${BASE_URL}admin/login`, { waitUntil: "domcontentloaded", timeout });
    await page.waitForSelector("form[action='/admin/login']", { timeout });
    record("Admin login page");
  } catch (err) {
    fail("Admin login page", err);
  }

  await browser.close();

  const report = [
    `BASE_URL: ${BASE_URL}`,
    `DATE: ${new Date().toISOString()}`,
    "",
    "STEPS:",
    ...steps,
    "",
    "ERRORS:",
    ...(errors.length ? errors : ["None"]),
  ].join("\n");

  console.log(report);

  if (errors.length) {
    try {
      const result = await sendResendEmail("[Theotimus] Flow test failed", report);
      if (result && result.sent) {
        console.log("Failure email sent.");
      } else {
        console.log(result?.reason || "Email not sent.");
      }
    } catch (err) {
      console.log("Failed to send email:", err.message || err);
    }
    process.exitCode = 1;
  } else {
    console.log(report);
  }
};

main().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exit(1);
});
