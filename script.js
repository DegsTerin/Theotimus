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

const productsCache = new Map();
let lastQuote = { shipping: 0, discount: 0 };

if (menuButton && siteNav) {
  menuButton.addEventListener("click", () => {
    siteNav.classList.toggle("open");
    menuButton.classList.toggle("open");
  });
}

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const rawCart = JSON.parse(localStorage.getItem("theotimus_cart") || "[]");
const cart = Array.isArray(rawCart)
  ? rawCart.filter((item) => item && item.productId && item.variantId)
  : [];

const formatCurrency = (value) => currencyFormatter.format(value);

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
      <button type="button" data-remove="${index}">Remover</button>
    `;
    cartItemsEl.appendChild(itemEl);
  });

  if (cart.length === 0) {
    cartItemsEl.innerHTML = "<p>Seu carrinho está vazio.</p>";
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
      showModal("Selecione uma variacao.");
      return;
    }
    const variant = product.variants.find((item) => item.id === variantId);
    if (!variant) {
      showModal("Variacao invalida.");
      return;
    }

    const existing = cart.find(
      (item) => item.productId === productId && item.variantId === variantId
    );
    const currentQty = existing ? existing.quantity : 0;
    if (currentQty + 1 > variant.stock) {
      showModal("Sem estoque suficiente para essa variacao.");
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
    showModal("Seu carrinho está vazio.");
    return;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  checkoutButton.disabled = true;
  checkoutButton.textContent = "Processando...";
  fetch("/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      items: cart,
      cep: cepInput?.value || "",
      coupon: couponInput?.value || "",
      email: emailInput?.value || "",
    }),
    signal: controller.signal,
  })
    .then(async (response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Falha ao iniciar o checkout.");
      }
      return response.json();
    })
    .then((data) => {
      if (!data.url) {
        throw new Error("Checkout nao retornou URL.");
      }
      window.location.href = data.url;
    })
    .catch((error) => {
      const message =
        error.name === "AbortError"
          ? "Tempo limite ao iniciar o checkout."
          : error.message || "Falha ao iniciar o checkout.";
      showModal(message);
    })
    .finally(() => {
      checkoutButton.disabled = false;
      checkoutButton.textContent = "Finalizar compra";
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
      stockEl.textContent = "Variacao indisponivel.";
      return;
    }

    priceEl.textContent = formatCurrency(variant.price);
    button.setAttribute("data-variant-id", variant.id);

    if (variant.stock <= 0) {
      button.disabled = true;
      stockEl.textContent = "Sem estoque.";
    } else {
      button.disabled = false;
      stockEl.textContent = `Estoque: ${variant.stock}`;
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
    showModal("Falha ao carregar produtos.");
  });
