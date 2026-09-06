import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, getDoc, getFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";

const els = { connection: document.querySelector("#connection"), notice: document.querySelector("#notice"), products: document.querySelector("#product-grid"), cart: document.querySelector("#cart"), total: document.querySelector("#total"), cartButton: document.querySelector("#cart-button"), cartModal: document.querySelector("#cart-modal"), cartModalList: document.querySelector("#cart-modal-list"), cartModalTotal: document.querySelector("#cart-modal-total"), cartModalClose: document.querySelector("#cart-modal-close"), cartModalClear: document.querySelector("#cart-modal-clear"), generate: document.querySelector("#generate-button"), clear: document.querySelector("#clear-button"), qrModal: document.querySelector("#qr-modal"), qrModalClose: document.querySelector("#qr-modal-close"), qr: document.querySelector("#qr-code"), qrText: document.querySelector("#qr-text"), modal: document.querySelector("#topping-modal"), modalTitle: document.querySelector("#modal-title"), modalBase: document.querySelector("#modal-base"), toppings: document.querySelector("#topping-grid"), modalTotal: document.querySelector("#modal-total"), skip: document.querySelector("#skip-topping"), add: document.querySelector("#add-with-topping") };
const db = getFirestore(initializeApp(firebaseConfig));
const auth = getAuth();
let products = [];
let cart = [];
let pendingProduct = null;
let selectedToppings = [];
let isFoodConfirmation = false;
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

/**
 * QRごとに表示するメニューセットをURLで指定する。
 * 例：?1&2 / ?sets=1,2 / ?set=1&set=2
 * 指定なしは従来どおり全セットを表示する。
 */
function menuCategoriesFromQuery() {
  const query = window.location.search.replace(/^\?/, "");
  if (!query) return null;
  const values = [];
  const params = new URLSearchParams(query);
  ["set", "sets", "menuCategory", "menuCategories"].forEach((key) => {
    params.getAll(key).forEach((value) => values.push(...value.split(",")));
  });
  query.split("&").forEach((token) => {
    const decoded = decodeURIComponent(token.replace(/\+/g, " "));
    if (/^\d+(?:,\d+)*$/.test(decoded)) values.push(...decoded.split(","));
  });
  const categories = [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= 9))].sort((a, b) => a - b);
  return categories.length ? new Set(categories) : null;
}

const selectedMenuCategories = menuCategoriesFromQuery();

function isTopping(product) { return String(product.category ?? "").includes("トッピング"); }
function csvRows(text) { const rows = []; let row = []; let value = ""; let quoted = false; for (let index = 0; index < text.length; index += 1) { const char = text[index]; if (char === '"') { if (quoted && text[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted; } else if (char === "," && !quoted) { row.push(value); value = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[index + 1] === "\n") index += 1; row.push(value); if (row.some((field) => field !== "")) rows.push(row); row = []; value = ""; } else value += char; } row.push(value); if (row.some((field) => field !== "")) rows.push(row); return rows; }
function csvProducts(text) { const [header = [], ...rows] = csvRows(text.replace(/^\uFEFF/, "")); return rows.map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""]))).map((item) => ({ id: item.id, name: item.name, priceYen: Number(item.priceYen), category: item.category, menuCategory: Number(item.menuCategory) || 1, sortOrder: Number(item.sortOrder), orderCode: Number(item.orderCode), colorCode: Number(item.colorCode) || 1, active: item.active.toLowerCase() === "true", soldOut: item.soldOut.toLowerCase() === "true", voucherEligible: item.voucherEligible.toLowerCase() === "true", toppingAllowed: item.toppingAllowed.toLowerCase() === "true", useKDS: item.useKDS?.toLowerCase() !== "false" })).filter((item) => item.id && item.name && Number.isFinite(item.priceYen)); }
function availableProducts() { return products.filter((product) => product.active && !product.soldOut && Number(product.orderCode) > 0 && (!selectedMenuCategories || selectedMenuCategories.has(product.menuCategory))); }
function renderProducts() { const orderProducts = availableProducts().filter((product) => !isTopping(product)); els.products.replaceChildren(); orderProducts.forEach((product) => { const button = document.createElement("button"); button.className = "product"; button.dataset.color = String(product.colorCode ?? 1); button.innerHTML = `<span class="product-name"></span><span class="price"></span>`; button.querySelector(".product-name").textContent = product.name; button.querySelector(".price").textContent = yen.format(product.priceYen); button.onclick = () => openToppingModal(product); els.products.append(button); }); if (!orderProducts.length) { els.notice.textContent = products.length ? "注文用商品コードが設定された販売中の商品がありません。商品マスタ管理で各商品の「注文QR用 商品コード」を1〜9999で登録してください。" : "商品マスタに商品がありません。"; } }
function cartRow(product, index) { const row = document.createElement("div"); row.className = "cart-row"; const text = document.createElement("span"); text.textContent = `${product.name}　${yen.format(product.priceYen)}`; const remove = document.createElement("button"); remove.textContent = "削除"; remove.onclick = () => { cart.splice(index, 1); renderCart(); }; row.append(text, remove); return row; }
function renderCart() { [els.cart, els.cartModalList].forEach((target) => { target.replaceChildren(); cart.forEach((product, index) => target.append(cartRow(product, index))); }); const total = cart.reduce((sum, product) => sum + Number(product.priceYen), 0); [els.total, els.cartModalTotal].forEach((target) => { target.textContent = `合計 ${yen.format(total)}`; }); els.generate.disabled = cart.length === 0; els.qrModal.hidden = true; }
function openToppingModal(product) { pendingProduct = product; selectedToppings = []; isFoodConfirmation = !product.toppingAllowed; const toppings = product.toppingAllowed ? availableProducts().filter(isTopping) : []; els.modalTitle.textContent = toppings.length ? "トッピングを選択（任意）" : "この商品を追加しますか？"; els.modalBase.textContent = `${product.name}　${yen.format(product.priceYen)}`; els.toppings.replaceChildren(); els.toppings.hidden = !toppings.length; els.skip.hidden = false; toppings.forEach((topping) => { const button = document.createElement("button"); button.className = "topping"; button.setAttribute("aria-pressed", "false"); button.innerHTML = `<span class="topping-name"></span><span class="price"></span><span class="topping-state">追加する</span>`; button.querySelector(".topping-name").textContent = topping.name; button.querySelector(".price").textContent = yen.format(topping.priceYen); const state = button.querySelector(".topping-state"); button.onclick = () => { const index = selectedToppings.findIndex((item) => item.id === topping.id); const selected = index < 0; if (selected) selectedToppings.push(topping); else selectedToppings.splice(index, 1); button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected)); state.textContent = selected ? "✓ 追加中" : "追加する"; updateModalTotal(); }; els.toppings.append(button); }); updateModalTotal(); els.modal.hidden = false; }
function updateModalTotal() { const total = [pendingProduct, ...selectedToppings].filter(Boolean).reduce((sum, product) => sum + Number(product.priceYen), 0); els.modalTotal.textContent = `この商品小計 ${yen.format(total)}`; els.add.textContent = isFoodConfirmation ? "追加" : selectedToppings.length ? "トッピングありで追加" : "トッピングなしで追加"; }
function addPending(withToppings) { if (!pendingProduct) return; cart.push(pendingProduct); if (withToppings) cart.push(...selectedToppings); pendingProduct = null; selectedToppings = []; els.modal.hidden = true; renderCart(); }
function cancelPending() { pendingProduct = null; selectedToppings = []; els.modal.hidden = true; }
function clearCart() { cart = []; renderCart(); }
function generateQr() { const text = `FPO1:${cart.map((product) => Number(product.orderCode)).join("+")}`; els.qr.replaceChildren(); new window.QRCode(els.qr, { text, width: 250, height: 250, correctLevel: window.QRCode.CorrectLevel.M }); els.qrText.textContent = text; els.qrModal.hidden = false; }
els.skip.onclick = cancelPending; els.add.onclick = () => addPending(true); els.clear.onclick = clearCart; els.cartModalClear.onclick = clearCart; els.generate.onclick = generateQr; els.cartButton.onclick = () => { els.cartModal.hidden = false; }; els.cartModalClose.onclick = () => { els.cartModal.hidden = true; }; els.qrModalClose.onclick = () => { els.qrModal.hidden = true; };
Promise.all([fetch("./item.csv", { cache: "no-store" }), signInAnonymously(auth)]).then(async ([response]) => { if (!response.ok) throw new Error(`item.csv を取得できませんでした（${response.status}）`); const [text, status] = await Promise.all([response.text(), getDoc(doc(db, "order_menu_status", "current"))]); if (!status.exists()) throw new Error("売切状態が未準備です。商品マスタ画面で商品を一度保存してください。"); const disabledCodes = new Set((status.data().disabledOrderCodes ?? []).map(Number)); products = csvProducts(text).map((product) => ({ ...product, soldOut: disabledCodes.has(product.orderCode) })).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja")); const setLabel = selectedMenuCategories ? `メニューセット ${[...selectedMenuCategories].join(",")} / ` : "全メニューセット / "; els.connection.textContent = `${setLabel}商品 ${availableProducts().length}件・売切状態を読み込み済み`; els.notice.textContent = ""; renderProducts(); }).catch((error) => { els.connection.textContent = "商品取得エラー"; els.notice.textContent = `メニューを読み込めませんでした：${error.message}`; });
