const menuButton = document.querySelector(".menu-button");
const siteNav = document.querySelector(".site-nav");
const cartButton = document.querySelector(".cart-button");
const cartDrawer = document.querySelector(".cart-drawer");
const cartOverlay = document.querySelector("[data-cart-overlay]");
const cartItemsEl = document.querySelector("[data-cart-items]");
const cartSubtotalEl = document.querySelector("[data-cart-subtotal]");
const cartShippingEl = document.querySelector("[data-cart-shipping]");
const cartDiscountEl = document.querySelector("[data-cart-discount]");
const cartTaxEl = document.querySelector("[data-cart-tax]");
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
const collectionGrid = document.querySelector("[data-collection-grid]");
const filterSearchInput = document.querySelector("[data-filter-search]");
const filterCategorySelect = document.querySelector("[data-filter-category]");
const filterMinInput = document.querySelector("[data-filter-min]");
const filterMaxInput = document.querySelector("[data-filter-max]");
const filterSortSelect = document.querySelector("[data-filter-sort]");
const filterNewToggle = document.querySelector("[data-filter-new]");
const filterBestToggle = document.querySelector("[data-filter-best]");
const filterResetButton = document.querySelector("[data-filter-reset]");
const filterResultCount = document.querySelector("[data-filter-count]");
let cartSyncTimeout = null;

const productsCache = new Map();
let lastQuote = { shipping: 0, discount: 0, tax: 0, taxLabel: "" };
let allProducts = [];
let applyFiltersFn = null;
let filtersBound = false;

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
    label_tax: "Taxas e impostos",
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
    filters_title: "Buscar e filtrar",
    filters_search: "Buscar por nome ou descricao",
    filters_category: "Categoria",
    filters_min: "Preco minimo",
    filters_max: "Preco maximo",
    filters_sort: "Ordenar por",
    filters_new: "Novidades",
    filters_best: "Mais vendidos",
    filters_reset: "Limpar filtros",
    filters_results: "resultados",
    filters_empty: "Nenhum produto encontrado.",
    filters_all: "Todas as categorias",
    filters_price_low: "Menor preco",
    filters_price_high: "Maior preco",
    filters_newest: "Novidades",
    filters_best_seller: "Mais vendidos",
    product_details: "Detalhes do produto",
    product_reviews: "Avaliacoes de clientes",
    product_reviews_empty: "Ainda nao ha avaliacoes.",
    product_back: "Voltar para a loja",
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
    label_tax: "Taxes",
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
    filters_title: "Search and filter",
    filters_search: "Search by name or description",
    filters_category: "Category",
    filters_min: "Min price",
    filters_max: "Max price",
    filters_sort: "Sort by",
    filters_new: "New arrivals",
    filters_best: "Best sellers",
    filters_reset: "Clear filters",
    filters_results: "results",
    filters_empty: "No products found.",
    filters_all: "All categories",
    filters_price_low: "Lowest price",
    filters_price_high: "Highest price",
    filters_newest: "Newest",
    filters_best_seller: "Best sellers",
    product_details: "Product details",
    product_reviews: "Customer reviews",
    product_reviews_empty: "No reviews yet.",
    product_back: "Back to store",
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

const scheduleCartSync = () => {
  if (!emailInput) {
    return;
  }
  if (cartSyncTimeout) {
    clearTimeout(cartSyncTimeout);
  }
  cartSyncTimeout = setTimeout(() => {
    const email = (emailInput.value || "").trim();
    if (!email || cart.length === 0) {
      return;
    }
    fetch("/api/cart/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, items: cart }),
    }).catch(() => {});
  }, 1500);
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
        <strong>${formatCurrency(item.price * item.quantity)}</strong>
      </div>
      <button type="button" data-remove="${index}">${locales[currentLocale].remove}</button>
    `;
    cartItemsEl.appendChild(itemEl);
  });

  if (cart.length === 0) {
    cartItemsEl.innerHTML = `<p>${locales[currentLocale].empty_cart}</p>`;
  }

  const taxAmount = typeof lastQuote.tax === "number" ? lastQuote.tax : 0;
  cartSubtotalEl.textContent = formatCurrency(total);
  cartShippingEl.textContent = formatCurrency(lastQuote.shipping || 0);
  cartDiscountEl.textContent = formatCurrency(lastQuote.discount || 0);
  if (cartTaxEl) {
    if (lastQuote.tax === null && lastQuote.taxLabel) {
      cartTaxEl.textContent = lastQuote.taxLabel;
    } else {
      cartTaxEl.textContent = formatCurrency(taxAmount);
    }
  }
  cartTotalEl.textContent = formatCurrency(
    total + (lastQuote.shipping || 0) + taxAmount - (lastQuote.discount || 0)
  );
  cartCountEl.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
  scheduleCartSync();
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
    lastQuote = {
      shipping: data.shipping,
      discount: data.discount,
      tax: typeof data.tax === "number" ? data.tax : null,
      taxLabel: data.taxLabel || "",
    };
    updateCartUI();
  } catch (error) {
    showModal(error.message || "Nao foi possivel calcular.");
  } finally {
    quoteButton.disabled = false;
  }
};

quoteButton?.addEventListener("click", refreshQuote);
emailInput?.addEventListener("blur", scheduleCartSync);

const bindAddToCartButtons = (root = document) => {
  root.querySelectorAll(".add-to-cart").forEach((button) => {
    if (button.dataset.bound === "1") {
      return;
    }
    button.dataset.bound = "1";
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
      lastQuote = { shipping: 0, discount: 0, tax: 0, taxLabel: "" };
      persistCart();
      updateCartUI();
      openCart();
    });
  });
};

bindAddToCartButtons();

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
  lastQuote = { shipping: 0, discount: 0, tax: 0, taxLabel: "" };
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

const getPriceRange = (product) => {
  const prices = product.variants.map((variant) => Number(variant.price) || 0);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return { min, max };
};

const renderCollectionGrid = (products) => {
  if (!collectionGrid) {
    return;
  }
  if (!products.length) {
    collectionGrid.innerHTML = `<div class="collection-empty">${locales[currentLocale].filters_empty}</div>`;
    if (filterResultCount) {
      filterResultCount.textContent = "0";
    }
    return;
  }
  collectionGrid.innerHTML = products
    .map((product) => {
      const priceRange = getPriceRange(product);
      const rating = product.rating || 0;
      const reviewCount = product.reviewCount || 0;
      const image = product.images && product.images.length ? product.images[0] : "";
      const tags = [];
      if (product.bestSeller) tags.push(currentLocale === "en-GB" ? "Best seller" : "Mais vendido");
      if (product.isNew) tags.push(currentLocale === "en-GB" ? "New" : "Novidade");
      if (product.category) tags.push(product.category);
      return `
        <article class="collection-card" data-product-id="${product.id}">
          <a class="image-box photo" href="product.html?id=${product.id}" style="${
            image ? `background-image:url('${image}')` : ""
          }">
            ${tags[0] ? `<span class="image-badge">${tags[0]}</span>` : ""}
          </a>
          <div class="card-tags">${tags.slice(1).map((tag) => `<span>${tag}</span>`).join("")}</div>
          <h3 data-product-name="${product.id}">${product.name}</h3>
          <p>${product.description || ""}</p>
          <div class="rating-line">${rating.toFixed(1)} / 5 (${reviewCount})</div>
          <div class="variant-selectors" data-product-id="${product.id}"></div>
          <div class="stock-status" data-product-id="${product.id}"></div>
          <div class="card-footer">
            <span class="price-tag product-price" data-product-id="${product.id}">
              ${formatCurrency(priceRange.min)}
            </span>
            <div class="card-actions-inline">
              <a class="ghost-button small" href="product.html?id=${product.id}">
                ${currentLocale === "en-GB" ? "Details" : "Detalhes"}
              </a>
              <button
                class="secondary-button small add-to-cart"
                type="button"
                data-product-id="${product.id}"
              >
                ${currentLocale === "en-GB" ? "Add" : "Adicionar"}
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  products.forEach((product) => renderVariantSelectors(product));
  bindAddToCartButtons(collectionGrid);
  if (filterResultCount) {
    filterResultCount.textContent = String(products.length);
  }
};

const setupFilters = (products) => {
  allProducts = products;
  if (!filterCategorySelect || !filterSortSelect || !filterSearchInput) {
    renderCollectionGrid(products);
    return;
  }

  const categories = Array.from(
    new Set(products.map((product) => product.category).filter(Boolean))
  );

  const currentCategory = filterCategorySelect.value;
  const currentSort = filterSortSelect.value;

  filterCategorySelect.innerHTML = `
    <option value="">${locales[currentLocale].filters_all}</option>
    ${categories.map((cat) => `<option value="${cat}">${cat}</option>`).join("")}
  `;

  filterSortSelect.innerHTML = `
    <option value="featured">${locales[currentLocale].filters_sort}</option>
    <option value="price_low">${locales[currentLocale].filters_price_low}</option>
    <option value="price_high">${locales[currentLocale].filters_price_high}</option>
    <option value="newest">${locales[currentLocale].filters_newest}</option>
    <option value="best">${locales[currentLocale].filters_best_seller}</option>
  `;

  if (currentCategory) {
    filterCategorySelect.value = currentCategory;
  }
  if (currentSort) {
    filterSortSelect.value = currentSort;
  }

  const priceRange = products.reduce(
    (acc, product) => {
      const range = getPriceRange(product);
      return {
        min: Math.min(acc.min, range.min),
        max: Math.max(acc.max, range.max),
      };
    },
    { min: Number.MAX_SAFE_INTEGER, max: 0 }
  );

  if (filterMinInput) {
    filterMinInput.placeholder = formatCurrency(priceRange.min);
  }
  if (filterMaxInput) {
    filterMaxInput.placeholder = formatCurrency(priceRange.max);
  }

  const applyFilters = () => {
    const query = (filterSearchInput.value || "").toLowerCase().trim();
    const category = filterCategorySelect.value;
    const min = Number(filterMinInput?.value || 0);
    const max = Number(filterMaxInput?.value || 0);
    const sort = filterSortSelect.value;
    const onlyNew = filterNewToggle?.classList.contains("active");
    const onlyBest = filterBestToggle?.classList.contains("active");

    let next = [...products];
    if (query) {
      next = next.filter(
        (product) =>
          product.name.toLowerCase().includes(query) ||
          (product.description || "").toLowerCase().includes(query) ||
          (product.category || "").toLowerCase().includes(query)
      );
    }
    if (category) {
      next = next.filter((product) => product.category === category);
    }
    if (onlyNew) {
      next = next.filter((product) => product.isNew);
    }
    if (onlyBest) {
      next = next.filter((product) => product.bestSeller);
    }
    if (min) {
      next = next.filter((product) => getPriceRange(product).min >= min);
    }
    if (max) {
      next = next.filter((product) => getPriceRange(product).min <= max);
    }
    if (sort === "price_low") {
      next.sort((a, b) => getPriceRange(a).min - getPriceRange(b).min);
    } else if (sort === "price_high") {
      next.sort((a, b) => getPriceRange(b).min - getPriceRange(a).min);
    } else if (sort === "newest") {
      next.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    } else if (sort === "best") {
      next.sort((a, b) => (b.bestSellerRank || 0) - (a.bestSellerRank || 0));
    }
    renderCollectionGrid(next);
  };
  applyFiltersFn = applyFilters;

  if (!filtersBound) {
    [filterSearchInput, filterCategorySelect, filterMinInput, filterMaxInput, filterSortSelect]
      .filter(Boolean)
      .forEach((input) => input.addEventListener("input", applyFilters));

    filterNewToggle?.addEventListener("click", () => {
      filterNewToggle.classList.toggle("active");
      applyFilters();
    });
    filterBestToggle?.addEventListener("click", () => {
      filterBestToggle.classList.toggle("active");
      applyFilters();
    });
    filterResetButton?.addEventListener("click", () => {
      filterSearchInput.value = "";
      filterCategorySelect.value = "";
      if (filterMinInput) filterMinInput.value = "";
      if (filterMaxInput) filterMaxInput.value = "";
      filterSortSelect.value = "featured";
      filterNewToggle?.classList.remove("active");
      filterBestToggle?.classList.remove("active");
      applyFilters();
    });
    filtersBound = true;
  }

  applyFilters();
};

fetch("/api/products")
  .then((res) => res.json())
  .then((data) => {
    data.forEach((product) => {
      productsCache.set(product.id, product);
      renderVariantSelectors(product);
    });
    setupFilters(data);
  })
  .catch(() => {
    showModal(locales[currentLocale].fetch_failed);
  });

const applySettings = () => {
  updateLocaleText();
  updateCartUI();
  productsCache.forEach((product) => renderVariantSelectors(product));
  if (allProducts.length) {
    setupFilters(allProducts);
  } else if (applyFiltersFn) {
    applyFiltersFn();
  }
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

window.Theotimus = {
  renderVariantSelectors,
  bindAddToCartButtons,
  formatCurrency,
  updateLocaleText,
  applySettings,
  openCart,
  productsCache,
  getLocale: () => currentLocale,
  getCurrency: () => currentCurrency,
};
