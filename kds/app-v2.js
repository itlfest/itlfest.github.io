import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { collection, doc, initializeFirestore, limit, onSnapshot, orderBy, query, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const KDS_PIN = "2026";
const states = {
  COOKING: { label: "調理中", action: "調理完了", next: "CALLING" },
  CALLING: { label: "呼び出し中", action: "提供完了", next: "DONE" },
  DONE: { label: "提供完了" },
  CANCELLED: { label: "取消" }
};
const els = {
  lock: document.querySelector("#pin-lock"), pin: document.querySelector("#pin-input"), unlock: document.querySelector("#unlock-button"), pinError: document.querySelector("#pin-error"),
  app: document.querySelector("#kds-app"), summary: document.querySelector("#summary"), filters: document.querySelector("#filters"), notice: document.querySelector("#notice"),
  orders: document.querySelector("#orders"), template: document.querySelector("#order-template"), demo: document.querySelector("#demo-button"), connection: document.querySelector("#connection-status")
};
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
// iPad Safari と一部の Wi-Fi 機器は WebChannel のストリーミング応答を
// 数十秒バッファすることがある。KDS は即時性を優先し、応答を変更ごとに
// 閉じる long-polling を明示的に使用する。
const db = initializeFirestore(firebaseApp, {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false
});
let selectedFilter = "ACTIVE";
let orders = [];
let productsById = new Map();
let unsubscribeOrders;
let unsubscribeProducts;
const renderedCards = new Map();
let emptyMessage = null;

function isTopping(line) {
  const category = String(productsById.get(line.productId)?.category ?? "");
  return category.includes("トッピング") || /^(\+|＋|追加[：:]?)/.test(String(line.productName ?? "").trim());
}
function groupLines(lines = []) {
  const groups = [];
  for (const line of lines) {
    if (isTopping(line) && groups.length) groups[groups.length - 1].toppings.push(line);
    else if (isTopping(line)) groups.push({ line: { ...line, productName: "追加・単品" }, toppings: [line], singleTopping: true });
    else groups.push({ line, toppings: [], singleTopping: false });
  }
  return groups;
}
function normalize(data) {
  return { documentNo: data.documentNo, exchangeNumber: String(data.exchangeNumber ?? "--").padStart(2, "0"), terminal: String(data.terminalId ?? "").padStart(3, "0"), confirmedAt: Number(data.confirmedAt ?? Date.now()), status: states[data.status] ? data.status : "COOKING", lines: Array.isArray(data.lines) ? data.lines : [] };
}
function renderFilters() {
  const filters = [["ACTIVE", "進行中"], ["COOKING", "調理中"], ["CALLING", "呼び出し中"], ["DONE", "提供完了"], ["CANCELLED", "取消"]];
  els.filters.replaceChildren(...filters.map(([value, label]) => {
    const button = document.createElement("button");
    button.className = `button filter ${selectedFilter === value ? "active" : ""}`;
    button.textContent = label;
    button.onclick = () => { selectedFilter = value; render(); };
    return button;
  }));
}
function lineText(line) { return `${line.productName ?? "商品"} ×${Number(line.quantity ?? 1)}`; }
async function changeState(documentNo, next, button) {
  button.disabled = true;
  try {
    const batch = writeBatch(db);
    const update = { status: next, updatedAt: Date.now() };
    batch.update(doc(db, "kds_orders", documentNo), update);
    batch.update(doc(db, "kds_display", documentNo), update);
    await batch.commit();
  } catch (error) { els.notice.textContent = `状態を更新できませんでした：${error.message}`; button.disabled = false; }
}
function card(order) {
  const fragment = els.template.content.cloneNode(true);
  const root = fragment.querySelector(".order-card");
  root.dataset.state = order.status;
  fragment.querySelector(".order-number").textContent = `#${order.exchangeNumber}`;
  fragment.querySelector(".order-meta").textContent = `${new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(order.confirmedAt)}　POS ${order.terminal}`;
  fragment.querySelector(".state-badge").textContent = states[order.status].label;
  const lines = fragment.querySelector(".order-lines");
  groupLines(order.lines).forEach((group) => {
    const dish = document.createElement("section"); dish.className = `dish ${group.singleTopping ? "single-topping" : ""}`;
    const main = document.createElement("p"); main.className = "dish-main"; main.textContent = lineText(group.line); dish.append(main);
    if (group.toppings.length) {
      const toppings = document.createElement("div"); toppings.className = "toppings";
      group.toppings.forEach((line) => { const chip = document.createElement("span"); chip.className = "topping"; chip.textContent = `＋ ${lineText(line).replace(/^[＋+]/, "").trim()}`; toppings.append(chip); });
      dish.append(toppings);
    }
    lines.append(dish);
  });
  const state = states[order.status];
  if (state.action) {
    const action = document.createElement("button"); action.className = "state-action"; action.textContent = state.action;
    action.onclick = () => changeState(order.documentNo, state.next, action);
    fragment.querySelector(".order-actions").append(action);
  }
  return root;
}

function orderRenderKey(order) {
  return JSON.stringify(order);
}

function clearRenderedCards() {
  renderedCards.clear();
  emptyMessage = null;
  els.orders.replaceChildren();
}

function render() {
  renderFilters();
  const counts = Object.keys(states).reduce((all, state) => ({ ...all, [state]: 0 }), {});
  orders.forEach((order) => { counts[order.status] += 1; });
  els.summary.textContent = `調理中 ${counts.COOKING}件　呼び出し中 ${counts.CALLING}件`;
  const visible = orders.filter((order) => selectedFilter === "ACTIVE" ? ["COOKING", "CALLING"].includes(order.status) : order.status === selectedFilter);
  const visibleIds = new Set(visible.map((order) => order.documentNo));
  for (const [documentNo, rendered] of renderedCards) {
    if (!visibleIds.has(documentNo)) {
      rendered.root.remove();
      renderedCards.delete(documentNo);
    }
  }
  if (!visible.length) {
    if (!emptyMessage) {
      emptyMessage = document.createElement("p");
      emptyMessage.className = "empty";
      emptyMessage.textContent = "表示する注文はありません。";
      els.orders.append(emptyMessage);
    }
    return;
  }
  emptyMessage?.remove();
  emptyMessage = null;
  visible.forEach((order) => {
    const renderKey = orderRenderKey(order);
    let rendered = renderedCards.get(order.documentNo);
    if (!rendered || rendered.renderKey !== renderKey) {
      rendered?.root.remove();
      rendered = { renderKey, root: card(order) };
      renderedCards.set(order.documentNo, rendered);
    }
    // append() は既存ノードを移動するだけなので、カードを作り直さず表示順だけ保てる。
    els.orders.append(rendered.root);
  });
}
async function connect() {
  els.connection.textContent = "Firebaseを接続中";
  await signInAnonymously(auth);
  unsubscribeProducts = onSnapshot(collection(db, "products"), (snapshot) => {
    productsById = new Map(snapshot.docs.map((item) => [item.id, item.data()]));
    // カテゴリ変更でトッピングの親子表示が変わり得るため、この時だけ全カードを作り直す。
    clearRenderedCards();
    render();
  });
  unsubscribeOrders = onSnapshot(query(collection(db, "kds_orders"), orderBy("confirmedAt", "desc"), limit(200)), (snapshot) => {
    orders = snapshot.docs.map((item) => normalize(item.data())).sort((a, b) => a.confirmedAt - b.confirmedAt);
    els.connection.textContent = "Firestore 接続中"; els.connection.className = "connection online"; els.notice.textContent = ""; render();
  }, (error) => { els.connection.textContent = "Firestore 接続エラー"; els.connection.className = "connection error"; els.notice.textContent = `注文を読み込めませんでした：${error.message}`; });
}
function showDemo() {
  unsubscribeOrders?.(); unsubscribeProducts?.(); productsById = new Map([["top", { category: "トッピング" }]]);
  clearRenderedCards();
  orders = [normalize({ documentNo: "demo-1", exchangeNumber: "01", terminalId: 401, confirmedAt: Date.now() - 60000, status: "COOKING", lines: [{ productId: "a", productName: "焼きそば", quantity: 1 }, { productId: "top", productName: "大盛り", quantity: 1 }, { productId: "top", productName: "マヨネーズ", quantity: 1 }] }), normalize({ documentNo: "demo-2", exchangeNumber: "02", terminalId: 401, confirmedAt: Date.now() - 30000, status: "CALLING", lines: [{ productId: "b", productName: "フランクフルト", quantity: 2 }] })];
  els.connection.textContent = "デモ表示中"; els.connection.className = "connection"; els.notice.textContent = "デモ注文です。再読み込みすると実データ表示へ戻ります。"; render();
}
function unlock() {
  if (els.pin.value !== KDS_PIN) { els.pinError.textContent = "PINが違います。"; els.pin.select(); return; }
  sessionStorage.setItem("festival-pos-kds-unlocked", "1");
  els.lock.hidden = true; els.app.hidden = false; connect().catch((error) => { els.notice.textContent = `KDSを開始できませんでした：${error.message}`; });
}
els.unlock.onclick = unlock;
els.pin.addEventListener("keydown", (event) => { if (event.key === "Enter") unlock(); });
els.demo.onclick = showDemo;
if (sessionStorage.getItem("festival-pos-kds-unlocked") === "1") unlock();
