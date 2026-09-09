import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { collection, initializeFirestore, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
// Kitchen KDS と同じく、iPad Safari / 一部 Wi-Fi のストリーミング応答の
// バッファリングを避け、更新をすぐ受け取れる long-polling を使用する。
const db = initializeFirestore(firebaseApp, {
  experimentalForceLongPolling: true,
  experimentalAutoDetectLongPolling: false
});
const cooking = document.querySelector("#cooking-numbers");
const calling = document.querySelector("#calling-numbers");
const connection = document.querySelector("#connection");
const voiceButton = document.querySelector("#voice-toggle");

const ANNOUNCEMENT_WAIT_MS = 1000;

let voiceEnabled = false;
let initialSnapshotReceived = false;
let previousCallingIds = new Set();
let pendingNumbers = new Set();
let announcementTimer = null;

function render(target, records, emptyText) {
  target.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }
  records.forEach((record) => {
    const number = document.createElement("div");
    number.className = "number";
    number.textContent = record.exchangeNumber;
    target.append(number);
  });
}

function getJapaneseVoice() {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  return voices.find((voice) => voice.lang === "ja-JP")
    ?? voices.find((voice) => voice.lang.startsWith("ja"))
    ?? null;
}

function speakNumbers(exchangeNumbers) {
  if (!voiceEnabled || !("speechSynthesis" in window) || !exchangeNumbers.length) return;

  const numberText = exchangeNumbers.map((number) => `${number}番`).join("、");
  const utterance = new SpeechSynthesisUtterance(
    `${numberText}のお客様、お待たせいたしました。商品をお受け取りください。`
  );
  utterance.lang = "ja-JP";
  utterance.rate = 0.9;
  utterance.pitch = 1;
  utterance.volume = 1;

  const voice = getJapaneseVoice();
  if (voice) utterance.voice = voice;

  window.speechSynthesis.speak(utterance);
}

function flushPendingAnnouncements() {
  announcementTimer = null;
  const numbers = [...pendingNumbers];
  pendingNumbers.clear();
  speakNumbers(numbers);
}

function queueAnnouncement(exchangeNumber) {
  if (!voiceEnabled) return;

  pendingNumbers.add(String(exchangeNumber));
  if (announcementTimer !== null) return;

  announcementTimer = window.setTimeout(flushPendingAnnouncements, ANNOUNCEMENT_WAIT_MS);
}

function clearPendingAnnouncements() {
  pendingNumbers.clear();
  if (announcementTimer !== null) {
    window.clearTimeout(announcementTimer);
    announcementTimer = null;
  }
}

function updateVoiceButton() {
  voiceButton.textContent = voiceEnabled ? "🔊 音声案内 ON" : "🔇 音声案内 OFF";
  voiceButton.classList.toggle("enabled", voiceEnabled);
  voiceButton.setAttribute("aria-pressed", String(voiceEnabled));
}

voiceButton.addEventListener("click", () => {
  if (!("speechSynthesis" in window)) {
    voiceButton.textContent = "音声案内 非対応";
    voiceButton.disabled = true;
    return;
  }

  voiceEnabled = !voiceEnabled;
  window.speechSynthesis.cancel();
  clearPendingAnnouncements();
  updateVoiceButton();

  if (voiceEnabled) {
    const confirmation = new SpeechSynthesisUtterance("音声案内を開始しました。");
    confirmation.lang = "ja-JP";
    confirmation.rate = 0.95;
    const voice = getJapaneseVoice();
    if (voice) confirmation.voice = voice;
    window.speechSynthesis.speak(confirmation);
  }
});

updateVoiceButton();

onSnapshot(query(collection(db, "kds_display"), orderBy("confirmedAt", "asc"), limit(200)), (snapshot) => {
  const records = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  const cookingRecords = records.filter((record) => record.status === "COOKING");
  const callingRecords = records.filter((record) => record.status === "CALLING");

  render(cooking, cookingRecords, "現在調理中の番号はありません");
  render(calling, callingRecords, "お呼び出し中の番号はありません");

  const currentCallingIds = new Set(callingRecords.map((record) => record.id));

  if (initialSnapshotReceived) {
    callingRecords
      .filter((record) => !previousCallingIds.has(record.id))
      .forEach((record) => queueAnnouncement(record.exchangeNumber));
  } else {
    initialSnapshotReceived = true;
  }

  previousCallingIds = currentCallingIds;
  connection.textContent = "更新中";
  connection.className = "connection";
}, (error) => {
  connection.textContent = `接続エラー：${error.message}`;
  connection.className = "connection error";
});
