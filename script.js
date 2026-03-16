const menuButton = document.querySelector(".menu-button");
const siteNav = document.querySelector(".site-nav");
const cartButton = document.querySelector(".cart-button");
const cartDrawer = document.querySelector(".cart-drawer");
const cartOverlay = document.querySelector("[data-cart-overlay]");
const cartItemsEl = document.querySelector("[data-cart-items]");
const cartSubtotalEl = document.querySelector("[data-cart-subtotal]");
const cartShippingEl = document.querySelector("[data-cart-shipping]");
const cartDiscountEl = document.querySelector("[data-cart-discount]");
const cartTotalEl = document.querySelector("[data-cart-total]");
const cartCountEl = document.querySelector(".cart-count");
const checkoutButton = document.querySelector("[data-checkout]");
const modal = document.querySelector(".modal");
const modalOverlay = document.querySelector("[data-modal-overlay]");
const modalClose = document.querySelector("[data-modal-close]");
const modalMessage = document.querySelector("[data-modal-message]");
const cepInput = document.querySelector("[data-cep-input]");
const emailInput = document.querySelector("[data-email-input]");
const couponInput = document.querySelector("[data-coupon-input]");
const quoteButton = document.querySelector("[data-quote]");
const localeSelect = document.querySelector("[data-locale-select]");
const currencySelect = document.querySelector("[data-currency-select]");

const productsCache = new Map();
let lastQuote = { shipping: 0, discount: 0 };

if (menuButton && siteNav) {
  menuButton.addEventListener("click", () => {
    siteNav.classList.toggle("open");
    menuButton.classList.toggle("open");
  });
}

const pageRoot = document.querySelector(".page");
const fxRates = {
  BRL: 1,
  USD: Number(pageRoot?.dataset.fxUsd || 0.2),
  EUR: Number(pageRoot?.dataset.fxEur || 0.18),
  GBP: Number(pageRoot?.dataset.fxGbp || 0.16),
};

const locales = {
  "pt-BR": {
    nav_collection: "Coleção",
    nav_highlights: "Destaques",
    nav_gifts: "Presentes",
    nav_contact: "Contato",
    btn_login: "Entrar",
    btn_cart: "Carrinho",
    btn_buy_now: "Comprar agora",
    hero_eyebrow: "Tradição, beleza e espiritualidade",
    hero_title: "Artigos religiosos que inspiram a sua fé, todos os dias.",
    hero_text:
      "Curadoria especial de terços, imagens sacras, livros e acessórios. Design contemporâneo com respeito à tradição.",
    btn_explore: "Explorar coleção",
    btn_news: "Ver novidades",
    badge_shipping_title: "Frete rápido",
    badge_shipping_sub: "para todo o Brasil",
    badge_installments_title: "Parcelamento",
    badge_installments_sub: "em até 6x sem juros",
    badge_warranty_title: "Garantia",
    badge_warranty_sub: "de troca em 7 dias",
    cart_title: "Seu carrinho",
    cart_subtitle: "Revise seus itens antes de finalizar.",
    btn_close: "Fechar",
    label_cep: "CEP para entrega",
    placeholder_cep: "00000-000",
    label_email: "E-mail para confirmacao",
    placeholder_email: "seuemail@exemplo.com",
    label_coupon: "Cupom de desconto",
    placeholder_coupon: "EX: BEMVINDO10",
    btn_quote: "Calcular frete e cupom",
    cart_note: "Preços exibidos podem variar. Conversão final no checkout do Stripe.",
    label_subtotal: "Subtotal",
    label_shipping: "Frete",
    label_discount: "Desconto",
    label_total: "Total",
    btn_checkout: "Finalizar compra",
    modal_title: "Aviso",
    empty_cart: "Seu carrinho está vazio.",
    remove: "Remover",
    processing: "Processando...",
    checkout_failed: "Falha ao iniciar o checkout.",
    checkout_timeout: "Tempo limite ao iniciar o checkout.",
    variant_required: "Selecione uma variacao.",
    variant_invalid: "Variacao invalida.",
    stock_empty: "Sem estoque.",
    stock_limited: "Sem estoque suficiente para essa variacao.",
    variant_unavailable: "Variacao indisponivel.",
    fetch_failed: "Falha ao carregar produtos.",
  },
  "en-GB": {
    nav_collection: "Collection",
    nav_highlights: "Highlights",
    nav_gifts: "Gifts",
    nav_contact: "Contact",
    btn_login: "Sign in",
    btn_cart: "Cart",
    btn_buy_now: "Shop now",
    hero_eyebrow: "Tradition, beauty and spirituality",
    hero_title: "Religious goods that inspire your faith, every day.",
    hero_text:
      "Curated rosaries, sacred art, books and accessories. Contemporary design with respect for tradition.",
    btn_explore: "Explore collection",
    btn_news: "See new arrivals",
    badge_shipping_title: "Fast shipping",
    badge_shipping_sub: "across Brazil",
    badge_installments_title: "Installments",
    badge_installments_sub: "up to 6x interest-free",
    badge_warranty_title: "Guarantee",
    badge_warranty_sub: "7-day exchange",
    cart_title: "Your cart",
    cart_subtitle: "Review your items before checkout.",
    btn_close: "Close",
    label_cep: "Postal code",
    placeholder_cep: "00000-000",
    label_email: "Confirmation email",
    placeholder_email: "you@example.com",
    label_coupon: "Discount code",
    placeholder_coupon: "EX: BEMVINDO10",
    btn_quote: "Calculate shipping and discount",
    cart_note: "Displayed prices may vary. Final conversion at Stripe checkout.",
    label_subtotal: "Subtotal",
    label_shipping: "Shipping",
    label_discount: "Discount",
    label_total: "Total",
    btn_checkout: "Checkout",
    modal_title: "Notice",
    empty_cart: "Your cart is empty.",
    remove: "Remove",
    processing: "Processing...",
    checkout_failed: "Failed to start checkout.",
    checkout_timeout: "Checkout timed out.",
    variant_required: "Please select a variant.",
    variant_invalid: "Invalid variant.",
    stock_empty: "Out of stock.",
    stock_limited: "Not enough stock for this variant.",
    variant_unavailable: "Variant unavailable.",
    fetch_failed: "Failed to load products.",
  },
};

const savedLocale = localStorage.getItem("theotimus_locale") || "pt-BR";
const savedCurrency = localStorage.getItem("theotimus_currency") || "BRL";
let currentLocale = locales[savedLocale] ? savedLocale : "pt-BR";
let currentCurrency = fxRates[savedCurrency] ? savedCurrency : "BRL";

const updateLocaleText = () => {
  const dict = locales[currentLocale];
  document.documentElement.lang = currentLocale;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key && dict[key]) {
      el.textContent = dict[key];
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (key && dict[key]) {
      el.setAttribute("placeholder", dict[key]);
    }
  });
};

const currencyFormatterFor = (currency) =>
  new Intl.NumberFormat(currentLocale, {
    style: "currency",
    currency,
  });

const rawCart = JSON.parse(localStorage.getItem("theotimus_cart") || "[]");
const cart = Array.isArray(rawCart)
  ? rawCart.filter((item) => item && item.productId && item.variantId)
  : [];

const formatCurrency = (value) => {
  const rate = fxRates[currentCurrency] || 1;
  const formatter = currencyFormatterFor(currentCurrency);
  return formatter.format(value * rate);
};

const persistCart = () => {
  localStorage.setItem("theotimus_cart", JSON.stringify(cart));
};

const updateCartUI = () => {
  if (!cartItemsEl || !cartTotalEl || !cartCountEl || !cartSubtotalEl) {
    return;
  }

  cartItemsEl.innerHTML = "";
  let total = 0;

  cart.forEach((item, index) => {
    total += item.price * item.quantity;
    const itemEl = document.createElement("div");
    itemEl.className = "cart-item";
    itemEl.innerHTML = `
      <h4>${item.name}</h4>
      ${item.variantLabel ? `<div class="cart-meta"><span>${item.variantLabel}</span></div>` : ""}
      <div class="cart-meta">
        <span>${item.quantity}x</span>
        <strong>${currencyFormatter.format(item.price * item.quantity)}</strong>
      </div>
      <button type="button" data-remove="${index}">${locales[currentLocale].remove}</button>
    `;
    cartItemsEl.appendChild(itemEl);
  });

  if (cart.length === 0) {
    cartItemsEl.innerHTML = `<p>${locales[currentLocale].empty_cart}</p>`;
  }

  cartSubtotalEl.textContent = formatCurrency(total);
  cartShippingEl.textContent = formatCurrency(lastQuote.shipping || 0);
  cartDiscountEl.textContent = formatCurrency(lastQuote.discount || 0);
  cartTotalEl.textContent = formatCurrency(total + (lastQuote.shipping || 0) - (lastQuote.discount || 0));
  cartCountEl.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
};

const openCart = () => {
  cartDrawer?.classList.add("open");
  cartOverlay?.classList.add("open");
  cartDrawer?.setAttribute("aria-hidden", "false");
};

const closeCart = () => {
  cartDrawer?.classList.remove("open");
  cartOverlay?.classList.remove("open");
  cartDrawer?.setAttribute("aria-hidden", "true");
};

const showModal = (message) => {
  if (modalMessage) {
    modalMessage.textContent = message;
  }
  modal?.classList.add("open");
  modalOverlay?.classList.add("open");
  modal?.setAttribute("aria-hidden", "false");
};

const closeModal = () => {
  modal?.classList.remove("open");
  modalOverlay?.classList.remove("open");
  modal?.setAttribute("aria-hidden", "true");
};

const refreshQuote = async () => {
  if (!quoteButton) {
    return;
  }
  quoteButton.disabled = true;
  try {
    const response = await fetch("/api/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: cart,
        cep: cepInput?.value || "",
        coupon: couponInput?.value || "",
        email: emailInput?.value || "",
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Nao foi possivel calcular.");
    }
    lastQuote = { shipping: data.shipping, discount: data.discount };
    updateCartUI();
  } catch (error) {
    showModal(error.message || "Nao foi possivel calcular.");
  } finally {
    quoteButton.disabled = false;
  }
};

quoteButton?.addEventListener("click", refreshQuote);

document.querySelectorAll(".add-to-cart").forEach((button) => {
  button.addEventListener("click", () => {
    const productId = button.getAttribute("data-product-id");
    if (!productId) {
      return;
    }
    const product = productsCache.get(productId);
    const variantId = button.getAttribute("data-variant-id");
    if (!product || !variantId) {
      showModal(locales[currentLocale].variant_required);
      return;
    }
    const variant = product.variants.find((item) => item.id === variantId);
    if (!variant) {
      showModal(locales[currentLocale].variant_invalid);
      return;
    }

    const existing = cart.find(
      (item) => item.productId === productId && item.variantId === variantId
    );
    const currentQty = existing ? existing.quantity : 0;
    if (currentQty + 1 > variant.stock) {
      showModal(locales[currentLocale].stock_limited);
      return;
    }

    const variantLabel = `${variant.size} · ${variant.color} · ${variant.material}`;
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        productId,
        variantId,
        name: product.name,
        variantLabel,
        price: variant.price,
        quantity: 1,
      });
    }
    lastQuote = { shipping: 0, discount: 0 };
    persistCart();
    updateCartUI();
    openCart();
  });
});

cartItemsEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const index = target.getAttribute("data-remove");
  if (index === null) {
    return;
  }
  cart.splice(Number(index), 1);
  lastQuote = { shipping: 0, discount: 0 };
  persistCart();
  updateCartUI();
});

cartButton?.addEventListener("click", openCart);
cartOverlay?.addEventListener("click", closeCart);
document.querySelector(".cart-close")?.addEventListener("click", closeCart);

checkoutButton?.addEventListener("click", () => {
  if (cart.length === 0) {
    showModal(locales[currentLocale].empty_cart);
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  checkoutButton.disabled = true;
  checkoutButton.textContent = locales[currentLocale].processing;
  fetch("/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: cart,
      cep: cepInput?.value || "",
      coupon: couponInput?.value || "",
      email: emailInput?.value || "",
      locale: currentLocale,
      currency: currentCurrency,
    }),
    signal: controller.signal,
  })
    .then(async (response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || locales[currentLocale].checkout_failed);
      }
      return response.json();
    })
    .then((data) => {
      if (!data.url) {
        throw new Error(locales[currentLocale].checkout_failed);
      }
      window.location.href = data.url;
    })
    .catch((error) => {
      const message =
        error.name === "AbortError"
          ? locales[currentLocale].checkout_timeout
          : error.message || locales[currentLocale].checkout_failed;
      showModal(message);
    })
    .finally(() => {
      checkoutButton.disabled = false;
      checkoutButton.textContent = locales[currentLocale].btn_checkout;
    });
});

modalOverlay?.addEventListener("click", () => {
  closeModal();
});

modalClose?.addEventListener("click", () => {
  closeModal();
});

updateCartUI();

const renderVariantSelectors = (product) => {
  const container = document.querySelector(
    `.variant-selectors[data-product-id="${product.id}"]`
  );
  const priceEl = document.querySelector(
    `.product-price[data-product-id="${product.id}"]`
  );
  const stockEl = document.querySelector(
    `.stock-status[data-product-id="${product.id}"]`
  );
  const button = document.querySelector(
    `.add-to-cart[data-product-id="${product.id}"]`
  );

  if (!container || !priceEl || !button) {
    return;
  }

  container.innerHTML = "";

  const sizes = [...new Set(product.variants.map((v) => v.size))];
  const colors = [...new Set(product.variants.map((v) => v.color))];
  const materials = [...new Set(product.variants.map((v) => v.material))];

  const createSelect = (label, options) => {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    options.forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt;
      option.textContent = `${label}: ${opt}`;
      select.appendChild(option);
    });
    return select;
  };

  const sizeSelect = createSelect("Tamanho", sizes);
  const colorSelect = createSelect("Cor", colors);
  const materialSelect = createSelect("Material", materials);

  container.appendChild(sizeSelect);
  container.appendChild(colorSelect);
  container.appendChild(materialSelect);

  const updateVariant = () => {
    const variant = product.variants.find(
      (v) =>
        v.size === sizeSelect.value &&
        v.color === colorSelect.value &&
        v.material === materialSelect.value
    );

    if (!variant) {
      button.disabled = true;
      stockEl.textContent = locales[currentLocale].variant_unavailable;
      return;
    }

    priceEl.textContent = formatCurrency(variant.price);
    button.setAttribute("data-variant-id", variant.id);

    if (variant.stock <= 0) {
      button.disabled = true;
      stockEl.textContent = locales[currentLocale].stock_empty;
    } else {
      button.disabled = false;
      stockEl.textContent = currentLocale === "en-GB" ? `Stock: ${variant.stock}` : `Estoque: ${variant.stock}`;
    }
  };

  [sizeSelect, colorSelect, materialSelect].forEach((select) => {
    select.addEventListener("change", updateVariant);
  });

  updateVariant();
};

fetch("/api/products")
  .then((res) => res.json())
  .then((data) => {
    data.forEach((product) => {
      productsCache.set(product.id, product);
      renderVariantSelectors(product);
    });
  })
  .catch(() => {
    showModal(locales[currentLocale].fetch_failed);
  });

const applySettings = () => {
  updateLocaleText();
  updateCartUI();
  productsCache.forEach((product) => renderVariantSelectors(product));
};

localeSelect?.addEventListener("change", () => {
  currentLocale = localeSelect.value;
  localStorage.setItem("theotimus_locale", currentLocale);
  applySettings();
});

currencySelect?.addEventListener("change", () => {
  currentCurrency = currencySelect.value;
  localStorage.setItem("theotimus_currency", currentCurrency);
  applySettings();
});

if (localeSelect) {
  localeSelect.value = currentLocale;
}
if (currencySelect) {
  currencySelect.value = currentCurrency;
}
updateLocaleText();
