const STORAGE_KEY = "isbn_scanner_entries_v1";
const SCAN_COOLDOWN_MS = 1200;

const cameraEl = document.getElementById("camera");
const fallbackReaderEl = document.getElementById("fallbackReader");
const overlayEl = document.querySelector(".overlay");
const startBtn = document.getElementById("startBtn");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const statusText = document.getElementById("statusText");
const countEl = document.getElementById("count");
const isbnList = document.getElementById("isbnList");

let entries = loadEntries();
let isbnSet = new Set(entries.map((entry) => entry.isbn));
let detector = null;
let html5Qrcode = null;
let stream = null;
let rafId = null;
let lastScanAt = 0;
let scanningActive = false;
let scannerMode = null;
let nativeStartedAt = 0;
let nativeFallbackTriggered = false;

render();
registerServiceWorker();

startBtn.addEventListener("click", startCameraAndScan);
exportBtn.addEventListener("click", exportCsv);
clearBtn.addEventListener("click", clearEntries);

autoStartIfPossible();

async function autoStartIfPossible() {
  try {
    await startCameraAndScan();
  } catch {
    // iOS needs a user interaction for camera permissions in many cases.
  }
}

async function startCameraAndScan() {
  try {
    setStatus("Starte Kamera...");

    if (!window.isSecureContext) {
      setStatus("Kamera geht nur über HTTPS oder localhost.");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Kamera-API ist auf diesem Gerät/Browser nicht verfügbar.");
      return;
    }

    if (scanningActive) {
      setStatus("Scanner läuft bereits.");
      return;
    }

    if ("BarcodeDetector" in window) {
      const supportsBookBarcodes = await supportsNativeBookBarcodeFormats();
      if (supportsBookBarcodes) {
        await startNativeScanner();
        return;
      }
    }

    await startFallbackScanner();
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      setStatus("Kamerazugriff blockiert. Bitte in Safari erlauben.");
      return;
    }
    if (error?.name === "NotFoundError") {
      setStatus("Keine Kamera gefunden.");
      return;
    }
    setStatus(`Kamera-Start fehlgeschlagen: ${error?.name || "Unbekannter Fehler"}`);
  }
}

async function supportsNativeBookBarcodeFormats() {
  try {
    const ua = navigator.userAgent || "";
    const isAppleWebKitMobile =
      /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isAppleWebKitMobile) {
      return false;
    }

    if (typeof window.BarcodeDetector?.getSupportedFormats !== "function") {
      return false;
    }
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const wanted = ["ean_13", "ean_8", "upc_a", "upc_e"];
    return wanted.some((format) => supported.includes(format));
  } catch {
    return false;
  }
}

async function startNativeScanner() {
  cameraEl.hidden = false;
  fallbackReaderEl.hidden = true;
  overlayEl.classList.remove("hidden");

  detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  });

  cameraEl.srcObject = stream;
  await cameraEl.play();
  scanningActive = true;
  scannerMode = "native";
  nativeStartedAt = Date.now();
  nativeFallbackTriggered = false;
  setStatus("Kamera aktiv. Bücher nacheinander scannen.");
  scanLoop();
}

async function startFallbackScanner() {
  if (!window.Html5Qrcode) {
    setStatus("Fallback-Scanner nicht geladen. Bitte Seite neu laden.");
    return;
  }

  cameraEl.hidden = true;
  fallbackReaderEl.hidden = false;
  overlayEl.classList.add("hidden");

  html5Qrcode = new Html5Qrcode("fallbackReader");
  const formatsToSupport = [];

  if (window.Html5QrcodeSupportedFormats?.EAN_13) {
    formatsToSupport.push(window.Html5QrcodeSupportedFormats.EAN_13);
  }
  if (window.Html5QrcodeSupportedFormats?.EAN_8) {
    formatsToSupport.push(window.Html5QrcodeSupportedFormats.EAN_8);
  }
  if (window.Html5QrcodeSupportedFormats?.UPC_A) {
    formatsToSupport.push(window.Html5QrcodeSupportedFormats.UPC_A);
  }
  if (window.Html5QrcodeSupportedFormats?.UPC_E) {
    formatsToSupport.push(window.Html5QrcodeSupportedFormats.UPC_E);
  }

  await html5Qrcode.start(
    { facingMode: "environment" },
    {
      fps: 12,
      aspectRatio: 4 / 3,
      disableFlip: false,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const width = Math.floor(Math.min(viewfinderWidth * 0.92, 560));
        const height = Math.floor(Math.max(110, Math.min(viewfinderHeight * 0.30, 220)));
        return { width, height };
      },
      formatsToSupport: formatsToSupport.length > 0 ? formatsToSupport : undefined
    },
    (decodedText) => {
      handleRawCode(decodedText);
    },
    () => {
      // Ignore continuous decode misses.
    }
  );

  scanningActive = true;
  scannerMode = "fallback";
  setStatus("Kamera aktiv (Safari-Fallback). Bücher nacheinander scannen.");
}

async function scanLoop() {
  if (!scanningActive) {
    return;
  }

  // iOS can expose BarcodeDetector but not decode EAN reliably.
  // If native mode doesn't decode quickly, switch to html5-qrcode fallback.
  if (
    scannerMode === "native" &&
    !nativeFallbackTriggered &&
    Date.now() - nativeStartedAt > 6000 &&
    entries.length === 0
  ) {
    nativeFallbackTriggered = true;
    await switchToFallbackScanner();
    return;
  }

  try {
    const barcodes = await detector.detect(cameraEl);
    if (barcodes.length > 0) {
      handleDetections(barcodes);
    }
  } catch {
    // Ignore occasional frame errors.
  }

  rafId = requestAnimationFrame(scanLoop);
}

async function switchToFallbackScanner() {
  try {
    scanningActive = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    detector = null;
    setStatus("Native-Erkennung schwach. Wechsle auf Safari-Fallback...");
    await startFallbackScanner();
  } catch {
    setStatus("Fallback-Wechsel fehlgeschlagen. Bitte Seite neu laden.");
  }
}

function handleDetections(barcodes) {
  if (Date.now() - lastScanAt < SCAN_COOLDOWN_MS) {
    return;
  }

  for (const barcode of barcodes) {
    if (handleRawCode(barcode.rawValue)) {
      return;
    }
  }
}

function handleRawCode(rawValue) {
  const now = Date.now();
  if (now - lastScanAt < SCAN_COOLDOWN_MS) {
    return false;
  }

  const raw = normalizeDigits(rawValue);
  const isbn = toIsbn13(raw);
  if (!isbn) {
    return false;
  }

  if (isbnSet.has(isbn)) {
    setStatus(`Duplikat erkannt: ${isbn}`);
    lastScanAt = now;
    return true;
  }

  const entry = {
    isbn,
    scannedAt: new Date().toISOString()
  };

  entries.unshift(entry);
  isbnSet.add(isbn);
  persistEntries();
  render();
  beep();
  setStatus(`Gespeichert: ${isbn}`);
  lastScanAt = now;
  return true;
}

function normalizeDigits(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/[^0-9Xx]/g, "").toUpperCase();
}

function toIsbn13(raw) {
  if (!raw) {
    return null;
  }

  if (/^97[89]\d{10}$/.test(raw) && isValidIsbn13(raw)) {
    return raw;
  }

  // Some scanners (notably Safari fallbacks) occasionally drop the leading
  // digit of EAN-13 and return 12 digits like "783...". Recover by prefixing 9.
  if (/^\d{12}$/.test(raw)) {
    const repaired = `9${raw}`;
    if (/^97[89]\d{10}$/.test(repaired) && isValidIsbn13(repaired)) {
      return repaired;
    }
  }

  if (/^\d{9}[0-9X]$/.test(raw) && isValidIsbn10(raw)) {
    return convertIsbn10To13(raw);
  }

  return null;
}

function isValidIsbn13(isbn) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    const digit = Number(isbn[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(isbn[12]);
}

function isValidIsbn10(isbn10) {
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = isbn10[i];
    const value = char === "X" ? 10 : Number(char);
    if (Number.isNaN(value)) {
      return false;
    }
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

function convertIsbn10To13(isbn10) {
  const base = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < base.length; i += 1) {
    sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${base}${check}`;
}

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function clearEntries() {
  entries = [];
  isbnSet = new Set();
  persistEntries();
  render();
  setStatus("Liste wurde geleert.");
}

function render() {
  countEl.textContent = String(entries.length);
  isbnList.innerHTML = "";

  for (const entry of entries) {
    const item = document.createElement("li");
    const date = new Date(entry.scannedAt);
    const localTime = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleString("de-DE", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        });

    item.innerHTML = `<span>${entry.isbn}</span><span>${localTime}</span>`;
    isbnList.appendChild(item);
  }
}

function exportCsv() {
  if (entries.length === 0) {
    setStatus("Noch keine ISBN vorhanden.");
    return;
  }

  const rows = ["isbn,scanned_at"];
  for (const entry of entries.slice().reverse()) {
    rows.push(`${entry.isbn},${entry.scannedAt}`);
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `isbn-scan-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("CSV wurde exportiert.");
}

function setStatus(text) {
  statusText.textContent = text;
}

function beep() {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.value = 740;
    gain.gain.value = 0.05;

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
  } catch {
    // Audio may be blocked, that's fine.
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Ignore registration failure.
  });
}

window.addEventListener("beforeunload", stopScanning);

function stopScanning() {
  scanningActive = false;
  nativeStartedAt = 0;
  nativeFallbackTriggered = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
  }

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  stream = null;
  detector = null;

  if (html5Qrcode && scannerMode === "fallback") {
    html5Qrcode
      .stop()
      .catch(() => {
        // ignore
      })
      .finally(() => {
        html5Qrcode = null;
      });
  }
}
