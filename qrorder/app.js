const els = {
  connection: document.querySelector("#connection"),
  notice: document.querySelector("#notice"),
  products: document.querySelector("#product-grid"),
  cart: document.querySelector("#cart"),
  total: document.querySelector("#total"),
  cartButton: document.querySelector("#cart-button"),
  cartModal: document.querySelector("#cart-modal"),
  cartModalList: document.querySelector("#cart-modal-list"),
  cartModalTotal: document.querySelector("#cart-modal-total"),
  cartModalClose: document.querySelector("#cart-modal-close"),
  cartModalClear: document.querySelector("#cart-modal-clear"),
  generate: document.querySelector("#generate-button"),
  clear: document.querySelector("#clear-button"),
  qrModal: document.querySelector("#qr-modal"),
  qrModalClose: document.querySelector("#qr-modal-close"),
  qr: document.querySelector("#qr-code"),
  qrText: document.querySelector("#qr-text"),
  modal: document.querySelector("#product-modal"),
  modalTitle: document.querySelector("#modal-title"),
  modalBase: document.querySelector("#modal-base"),
  modalTotal: document.querySelector("#modal-total"),
  cancel: document.querySelector("#cancel-product"),
  add: document.querySelector("#add-product"),
};

let products = [];

// カートは商品単位で保持する。
let cart = [];
let pendingProduct = null;

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

/**
 * URLで表示するメニューセットを指定する。
 *
 * 対応例:
 * ?1
 * ?1&2
 * ?sets=1
 * ?sets=1,2
 * ?set=1&set=2
 *
 * 指定なしの場合は全メニューセットを表示する。
 */
function menuCategoriesFromQuery() {
  const query = window.location.search.replace(/^\?/, "");

  if (!query) {
    return null;
  }

  const values = [];
  const params = new URLSearchParams(query);

  ["set", "sets", "menuCategory", "menuCategories"].forEach((key) => {
    params.getAll(key).forEach((value) => {
      values.push(...value.split(","));
    });
  });

  /*
   * ?1&2 のような簡易形式にも対応
   */
  query.split("&").forEach((token) => {
    const decoded = decodeURIComponent(token.replace(/\+/g, " "));

    if (/^\d+(?:,\d+)*$/.test(decoded)) {
      values.push(...decoded.split(","));
    }
  });

  const categories = [
    ...new Set(
      values
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 9),
    ),
  ].sort((a, b) => a - b);

  return categories.length ? new Set(categories) : null;
}

const selectedMenuCategories = menuCategoriesFromQuery();

/**
 * トッピング商品かどうかを判定
 */
function isTopping(product) {
  return String(product.category ?? "").includes("トッピング");
}

/**
 * CSV文字列を解析する。
 * ダブルクォート・カンマ・改行入りフィールドにも対応。
 */
function csvRows(text) {
  const rows = [];

  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }

      row.push(value);

      if (row.some((field) => field !== "")) {
        rows.push(row);
      }

      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  row.push(value);

  if (row.some((field) => field !== "")) {
    rows.push(row);
  }

  return rows;
}

/**
 * item.csv を商品オブジェクトに変換
 */
function csvProducts(text) {
  const [header = [], ...rows] = csvRows(text.replace(/^\uFEFF/, ""));

  return rows
    .map((row) =>
      Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])),
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      priceYen: Number(item.priceYen),
      category: item.category,

      menuCategory: Number(item.menuCategory) || 1,

      sortOrder: Number(item.sortOrder),

      orderCode: Number(item.orderCode),

      colorCode: Number(item.colorCode) || 1,

      active: String(item.active).toLowerCase() === "true",

      /*
       * CSVフォーマット互換のため読み込むが、
       * QR注文画面では soldOut は使用しない。
       *
       * 売切れ判定はレジ側で行う。
       */
      soldOut: String(item.soldOut).toLowerCase() === "true",

      voucherEligible: String(item.voucherEligible).toLowerCase() === "true",

      useKDS: item.useKDS?.toLowerCase() !== "false",
    }))
    .filter((item) => item.id && item.name && Number.isFinite(item.priceYen));
}

/**
 * QR注文画面に表示可能な商品
 *
 * soldOut は参照しない。
 * 売切れはレジ側で案内する。
 */
function availableProducts() {
  return products.filter(
    (product) =>
      product.active &&
      !isTopping(product) &&
      Number(product.orderCode) > 0 &&
      (!selectedMenuCategories ||
        selectedMenuCategories.has(product.menuCategory)),
  );
}

/**
 * 商品一覧を表示
 */
function renderProducts() {
  const orderProducts = availableProducts();

  els.products.replaceChildren();

  orderProducts.forEach((product) => {
    const button = document.createElement("button");

    button.className = "product";
    button.dataset.color = String(product.colorCode ?? 1);

    button.innerHTML = `
      <span class="product-name"></span>
      <span class="price"></span>
    `;

    button.querySelector(".product-name").textContent = product.name;

    button.querySelector(".price").textContent = yen.format(product.priceYen);

    button.onclick = () => {
      openProductModal(product);
    };

    els.products.append(button);
  });

  if (!orderProducts.length) {
    els.notice.textContent = products.length
      ? "注文用商品コードが設定された販売中の商品がありません。商品マスタ管理で各商品の「注文QR用 商品コード」を1〜9999で登録してください。"
      : "商品マスタに商品がありません。";
  }
}

/**
 * 1注文商品の小計を計算
 */
function cartItemSubtotal(item) {
  return Number(item.product.priceYen);
}

/**
 * カート1商品分を作成
 */
function cartRow(item, index) {
  const row = document.createElement("div");
  row.className = "cart-row";

  const content = document.createElement("div");
  content.className = "cart-item-content";

  /*
   * 商品
   */
  const main = document.createElement("div");
  main.className = "cart-item-main";

  const mainName = document.createElement("span");
  mainName.className = "cart-item-name";
  mainName.textContent = item.product.name;

  const mainPrice = document.createElement("span");
  mainPrice.className = "cart-item-price";
  mainPrice.textContent = yen.format(item.product.priceYen);

  main.append(mainName, mainPrice);

  content.append(main);

  /*
   * 商品の小計
   */
  const subtotal = document.createElement("div");

  subtotal.className = "cart-item-subtotal";

  subtotal.textContent = `小計 ${yen.format(cartItemSubtotal(item))}`;

  content.append(subtotal);

  /*
   * 商品単位で削除
   */
  const remove = document.createElement("button");

  remove.className = "cart-remove";

  remove.type = "button";
  remove.textContent = "削除";

  remove.onclick = () => {
    cart.splice(index, 1);
    renderCart();
  };

  row.append(content, remove);

  return row;
}

/**
 * カート表示更新
 */
function renderCart() {
  [els.cart, els.cartModalList].forEach((target) => {
    target.replaceChildren();

    cart.forEach((item, index) => {
      target.append(cartRow(item, index));
    });
  });

  const total = cart.reduce((sum, item) => sum + cartItemSubtotal(item), 0);

  [els.total, els.cartModalTotal].forEach((target) => {
    target.textContent = `合計 ${yen.format(total)}`;
  });

  els.generate.disabled = cart.length === 0;

  els.qrModal.hidden = true;
}

/**
 * 商品選択時の追加確認
 */
function openProductModal(product) {
  pendingProduct = product;
  els.modalTitle.textContent = "この商品を追加しますか？";
  els.modalBase.textContent = `${product.name}　${yen.format(product.priceYen)}`;
  els.modalTotal.textContent = `この商品小計 ${yen.format(product.priceYen)}`;
  els.modal.hidden = false;
}

/**
 * 商品をカートへ追加
 */
function addPending() {
  if (!pendingProduct) {
    return;
  }

  cart.push({ product: pendingProduct });
  pendingProduct = null;
  els.modal.hidden = true;
  renderCart();
}

/**
 * 商品追加をキャンセル
 */
function cancelPending() {
  pendingProduct = null;
  els.modal.hidden = true;
}

/**
 * カート全削除
 */
function clearCart() {
  cart = [];
  renderCart();
}

/**
 * 注文QR生成。商品コードを選択順に連結する。
 * 例: FPO1:7+7+13
 */
function generateQr() {
  const orderCodes = cart.map((item) => Number(item.product.orderCode));

  const text = `FPO1:${orderCodes.join("+")}`;

  els.qr.replaceChildren();

  new window.QRCode(els.qr, {
    text,
    width: 125,
    height: 125,

    correctLevel: window.QRCode.CorrectLevel.M,
  });

  els.qrText.textContent = text;

  els.qrModal.hidden = false;
}

/*
 * UIイベント
 */

els.cancel.onclick = cancelPending;

els.add.onclick = addPending;

els.clear.onclick = clearCart;

els.cartModalClear.onclick = clearCart;

els.generate.onclick = generateQr;

els.cartButton.onclick = () => {
  els.cartModal.hidden = false;
};

els.cartModalClose.onclick = () => {
  els.cartModal.hidden = true;
};

els.qrModalClose.onclick = () => {
  els.qrModal.hidden = true;
};

/**
 * 商品情報読み込み
 *
 * Firebase / Firestore は使用しない。
 * GitHub Pages上の item.csv のみ参照する。
 */
fetch("./item.csv", {
  cache: "no-store",
})
  .then(async (response) => {
    if (!response.ok) {
      throw new Error(`item.csv を取得できませんでした（${response.status}）`);
    }

    const text = await response.text();

    products = csvProducts(text).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"),
    );

    const setLabel = selectedMenuCategories
      ? `メニューセット ${[...selectedMenuCategories].join(",")} / `
      : "全メニューセット / ";

    els.connection.textContent = `${setLabel}商品 ${availableProducts().length}件`;

    els.notice.textContent = "";

    renderProducts();
    renderCart();
  })
  .catch((error) => {
    console.error(error);

    els.connection.textContent = "商品取得エラー";

    els.notice.textContent = `メニューを読み込めませんでした：${error.message}`;
  });
