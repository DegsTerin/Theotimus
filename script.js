const menuButton = document.querySelector(".menu-button");
const siteNav = document.querySelector(".site-nav");
const cartButton = document.querySelector(".cart-button");
const cartDrawer = document.querySelector(".cart-drawer");
const cartOverlay = document.querySelector("[data-cart-overlay]");
const cartItemsEl = document.querySelector("[data-cart-items]");
const cartTotalEl = document.querySelector("[data-cart-total]");
const cartCountEl = document.querySelector(".cart-count");
const checkoutButton = document.querySelector("[data-checkout]");
const modal = document.querySelector(".modal");
const modalOverlay = document.querySelector("[data-modal-overlay]");
const modalClose = document.querySelector("[data-modal-close]");
const modalMessage = document.querySelector("[data-modal-message]");

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

const cart = JSON.parse(localStorage.getItem("theotimus_cart") || "[]");

const persistCart = () => {
  localStorage.setItem("theotimus_cart", JSON.stringify(cart));
};

const updateCartUI = () => {
  if (!cartItemsEl || !cartTotalEl || !cartCountEl) {
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

  cartTotalEl.textContent = currencyFormatter.format(total);
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

document.querySelectorAll(".add-to-cart").forEach((button) => {
  button.addEventListener("click", () => {
    const name = button.getAttribute("data-product");
    const price = Number(button.getAttribute("data-price"));
    if (!name || Number.isNaN(price)) {
      return;
    }

    const existing = cart.find((item) => item.name === name);
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({ name, price, quantity: 1 });
    }
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
  fetch("/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart }),
  })
    .then(async (response) => {
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
      showModal(error.message || "Falha ao iniciar o checkout.");
    });
});

modalOverlay?.addEventListener("click", () => {
  closeModal();
});

modalClose?.addEventListener("click", () => {
  closeModal();
});

updateCartUI();
