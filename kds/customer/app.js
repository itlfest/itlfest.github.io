import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { collection, initializeFirestore, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "../firebase-config.js";
import { coefontProxyUrl } from "./coefont-config.js";

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
const COEFONT_TIMEOUT_MS = 6000;
const COEFONT_MAX_FAILURES = 2;
const COEFONT_COOLDOWN_MS = 5 * 60 * 1000;

let voiceEnabled = false;
let initialSnapshotReceived = false;
let previousCallingIds = new Set();
let pendingNumbers = new Set();
let announcementTimer = null;
const coefontAudio = new Audio();
let coefontRequestAbort = null;
let announcementQueue = Promise.resolve();
let coefontAudioUrl = null;
let coefontAudioUnlocked = false;
let coefontFailures = 0;
let coefontDisabledUntil = 0;

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

function speakWithBrowser(exchangeNumbers) {
  if (!("speechSynthesis" in window) || !exchangeNumbers.length) return;

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

function clearCoeFontAudio() {
  coefontAudio.pause();
  coefontAudio.removeAttribute("src");
  if (coefontAudioUrl) URL.revokeObjectURL(coefontAudioUrl);
  coefontAudioUrl = null;
}

function createSilentWavUrl() {
  const sampleRate = 8000;
  const samples = new Uint8Array(sampleRate / 10).fill(128);
  const buffer = new ArrayBuffer(44 + samples.length);
  const view = new DataView(buffer);
  const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));

  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeText(36, "data");
  view.setUint32(40, samples.length, true);
  new Uint8Array(buffer, 44).set(samples);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function unlockCoeFontAudio() {
  if (coefontAudioUnlocked) return;

  const silenceUrl = createSilentWavUrl();
  const releaseSilence = () => URL.revokeObjectURL(silenceUrl);
  coefontAudio.src = silenceUrl;
  coefontAudio.addEventListener("ended", releaseSilence, { once: true });
  void coefontAudio.play().then(() => {
    coefontAudioUnlocked = true;
  }).catch(() => {
    coefontAudio.removeAttribute("src");
    releaseSilence();
  });
}

async function speakWithCoeFont(exchangeNumbers) {
  if (!coefontProxyUrl) throw new Error("CoeFont Worker is not configured");
  if (!exchangeNumbers.length) return;
  if (!coefontAudioUnlocked) throw new Error("CoeFont audio is not unlocked");

  const controller = new AbortController();
  coefontRequestAbort = controller;
  const timeout = window.setTimeout(() => controller.abort(), COEFONT_TIMEOUT_MS);
  try {
    const result = await fetch(coefontProxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numbers: exchangeNumbers }),
      signal: controller.signal
    });
    if (!result.ok) throw new Error(`CoeFont Worker returned ${result.status}`);

    const audioUrl = URL.createObjectURL(await result.blob());
    clearCoeFontAudio();
    coefontAudioUrl = audioUrl;
    coefontAudio.src = audioUrl;
    try {
      await coefontAudio.play();
      await new Promise((resolve, reject) => {
        const finish = (callback) => {
          coefontAudio.removeEventListener("ended", onEnded);
          coefontAudio.removeEventListener("pause", onPause);
          coefontAudio.removeEventListener("error", onError);
          callback();
        };
        const onEnded = () => finish(resolve);
        const onPause = () => finish(resolve);
        const onError = () => finish(() => reject(new Error("CoeFont audio playback failed")));
        coefontAudio.addEventListener("ended", onEnded);
        coefontAudio.addEventListener("pause", onPause);
        coefontAudio.addEventListener("error", onError);
      });
    } finally {
      clearCoeFontAudio();
    }
  } finally {
    window.clearTimeout(timeout);
    if (coefontRequestAbort === controller) coefontRequestAbort = null;
  }
}

async function speakNumbers(exchangeNumbers) {
  if (!voiceEnabled || !exchangeNumbers.length) return;
  if (Date.now() < coefontDisabledUntil) {
    speakWithBrowser(exchangeNumbers);
    return;
  }

  try {
    await speakWithCoeFont(exchangeNumbers);
    coefontFailures = 0;
  } catch (error) {
    console.warn("CoeFont announcement failed. Falling back to browser speech.", error);
    coefontFailures += 1;
    if (coefontFailures >= COEFONT_MAX_FAILURES) {
      coefontDisabledUntil = Date.now() + COEFONT_COOLDOWN_MS;
      console.warn("CoeFont announcements paused after repeated failures.");
    }
    if (voiceEnabled) speakWithBrowser(exchangeNumbers);
  }
}

function flushPendingAnnouncements() {
  announcementTimer = null;
  const numbers = [...pendingNumbers];
  pendingNumbers.clear();
  announcementQueue = announcementQueue
    .catch((error) => console.error("Previous announcement failed", error))
    .then(() => speakNumbers(numbers))
    .catch((error) => console.error("Announcement failed", error));
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
  if (!coefontProxyUrl && !("speechSynthesis" in window)) {
    voiceButton.textContent = "音声案内 非対応";
    voiceButton.disabled = true;
    return;
  }

  voiceEnabled = !voiceEnabled;
  window.speechSynthesis?.cancel();
  coefontRequestAbort?.abort();
  clearCoeFontAudio();
  clearPendingAnnouncements();
  updateVoiceButton();

  if (voiceEnabled && "speechSynthesis" in window) {
    const confirmation = new SpeechSynthesisUtterance("音声案内を開始しました。");
    confirmation.lang = "ja-JP";
    confirmation.rate = 0.95;
    const voice = getJapaneseVoice();
    if (voice) confirmation.voice = voice;
    window.speechSynthesis.speak(confirmation);
  }
  if (voiceEnabled && coefontProxyUrl) {
    coefontFailures = 0;
    coefontDisabledUntil = 0;
    unlockCoeFontAudio();
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
