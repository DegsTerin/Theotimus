const galleryEl = document.querySelector("[data-product-gallery]");
const infoEl = document.querySelector("[data-product-info]");
const reviewsEl = document.querySelector("[data-product-reviews]");

const params = new URLSearchParams(window.location.search);
const productId = params.get("id") || "";

const placeholderImage = (name) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'>
  <defs>
    <linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>
      <stop offset='0%' stop-color='#7c1414'/>
      <stop offset='100%' stop-color='#c2a04a'/>
    </linearGradient>
  </defs>
  <rect width='800' height='600' fill='url(#g)'/>
  <text x='50%' y='50%' font-size='48' fill='#fff' text-anchor='middle' font-family='Cinzel, serif'>${name}</text>
</svg>
`)}'`;

const renderProduct = (product) => {
  const locale = window.Theotimus?.getLocale?.() || "pt-BR";
  const formatCurrency = window.Theotimus?.formatCurrency || ((v) => v);
  const images = product.images && product.images.length ? product.images : [placeholderImage(product.name)];

  let mainImage = images[0];

  const renderGallery = () => {
    if (!galleryEl) return;
    galleryEl.innerHTML = `
      <div class="gallery-main">
        <img src="${mainImage}" alt="${product.name}" />
      </div>
      <div class="gallery-thumbs">
        ${images
          .map(
            (img, index) => `
              <button type="button" class="thumb" data-img-index="${index}">
                <img src="${img}" alt="${product.name} ${index + 1}" />
              </button>
            `
          )
          .join("")}
      </div>
    `;

    galleryEl.querySelectorAll(".thumb").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-img-index"));
        mainImage = images[idx] || images[0];
        renderGallery();
      });
    });
  };

  const priceRange = product.variants.reduce(
    (acc, variant) => {
      const price = Number(variant.price) || 0;
      return { min: Math.min(acc.min, price), max: Math.max(acc.max, price) };
    },
    { min: Number.MAX_SAFE_INTEGER, max: 0 }
  );

  if (infoEl) {
    infoEl.innerHTML = `
      <div class="product-meta">${product.category || ""}</div>
      <h1>${product.name}</h1>
      <p>${product.description || ""}</p>
      <div class="rating-line">${(product.rating || 0).toFixed(1)} / 5 (${product.reviewCount || 0})</div>
      <div class="variant-selectors" data-product-id="${product.id}"></div>
      <div class="stock-status" data-product-id="${product.id}"></div>
      <div class="product-price-row">
        <strong class="product-price" data-product-id="${product.id}">${formatCurrency(priceRange.min)}</strong>
        <button class="primary-button add-to-cart" type="button" data-product-id="${product.id}">
          ${locale === "en-GB" ? "Add to cart" : "Adicionar ao carrinho"}
        </button>
      </div>
      <a class="ghost-button" href="/" data-i18n="product_back">Voltar para a loja</a>
    `;
  }

  if (reviewsEl) {
    const reviews = Array.isArray(product.reviews) ? product.reviews : [];
    reviewsEl.innerHTML = `
      <div class="section-header">
        <div>
          <span class="section-eyebrow">${locale === "en-GB" ? "Reviews" : "Avaliacoes"}</span>
          <h2 data-i18n="product_reviews">Avaliacoes de clientes</h2>
        </div>
      </div>
      <div class="testimonial-grid">
        ${
          reviews.length
            ? reviews
                .map(
                  (review) => `
                    <blockquote>
                      <p>"${review.text}"</p>
                      <cite>${review.name} · ${review.date}</cite>
                    </blockquote>
                  `
                )
                .join("")
            : `<div class="collection-empty" data-i18n="product_reviews_empty">Ainda nao ha avaliacoes.</div>`
        }
      </div>
    `;
  }

  renderGallery();
  if (window.Theotimus?.productsCache) {
    window.Theotimus.productsCache.set(product.id, product);
  }
  window.Theotimus?.renderVariantSelectors?.(product);
  window.Theotimus?.bindAddToCartButtons?.(document);
};

if (!productId) {
  if (infoEl) {
    infoEl.innerHTML = "Produto nao encontrado.";
  }
} else {
  fetch("/api/products")
    .then((res) => res.json())
    .then((data) => {
      const product = data.find((item) => item.id === productId);
      if (!product) {
        if (infoEl) {
          infoEl.innerHTML = "Produto nao encontrado.";
        }
        return;
      }
      renderProduct(product);
      window.Theotimus?.applySettings?.();
    })
    .catch(() => {
      if (infoEl) {
        infoEl.innerHTML = "Produto nao encontrado.";
      }
    });
}
