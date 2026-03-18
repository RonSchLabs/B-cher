const STORAGE_KEY = "isbn_scanner_entries_v1";
const SCAN_COOLDOWN_MS = 1200;
const QUAGGA_READERS = ["ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader"];

const cameraEl = document.getElementById("camera");
const fallbackReaderEl = document.getElementById("fallbackReader");
const overlayEl = document.querySelector(".overlay");
const startBtn = document.getElementById("startBtn");
const photoScanBtn = document.getElementById("photoScanBtn");
const photoInput = document.getElementById("photoInput");
const exportBtn = document.getElementById("exportBtn");
const clearBtn = document.getElementById("clearBtn");
const statusText = document.getElementById("statusText");
const countEl = document.getElementById("count");
const isbnList = document.getElementById("isbnList");

let entries = loadEntries();
let isbnSet = new Set(entries.map((entry) => entry.isbn));
let lastScanAt = 0;
let scanningActive = false;
let quaggaHandler = null;

render();
registerServiceWorker();

startBtn.addEventListener("click", startCameraAndScan);
photoScanBtn.addEventListener("click", triggerPhotoScan);
photoInput.addEventListener("change", onPhotoSelected);
exportBtn.addEventListener("click", exportCsv);
clearBtn.addEventListener("click", clearEntries);

autoStartIfPossible();

async function autoStartIfPossible() {
  try {
    await startCameraAndScan();
  } catch {
    // iOS often needs user interaction for camera permissions.
  }
}

async function startCameraAndScan() {
  if (!window.isSecureContext) {
    setStatus("Kamera geht nur über HTTPS oder localhost.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Kamera-API ist auf diesem Gerät/Browser nicht verfügbar.");
    return;
  }

  if (!window.Quagga) {
    setStatus("Scanner-Bibliothek nicht geladen. Bitte Seite neu laden.");
    return;
  }

  if (scanningActive) {
    setStatus("Scanner läuft bereits. Bücher nacheinander scannen.");
    return;
  }

  try {
    setStatus("Starte Scanner...");
    await startQuaggaLiveScanner();
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      setStatus("Kamerazugriff blockiert. Bitte in Safari erlauben.");
      return;
    }
    if (error?.name === "NotFoundError") {
      setStatus("Keine Kamera gefunden.");
      return;
    }
    setStatus("Scanner-Start fehlgeschlagen. Bitte Seite neu laden.");
  }
}

function startQuaggaLiveScanner() {
  return new Promise((resolve, reject) => {
    cameraEl.hidden = true;
    fallbackReaderEl.hidden = false;
    overlayEl.classList.remove("hidden");
    fallbackReaderEl.innerHTML = "";

    window.Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target: fallbackReaderEl,
          constraints: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        },
        locator: {
          patchSize: "medium",
          halfSample: true
        },
        numOfWorkers: 0,
        frequency: 10,
        decoder: {
          readers: QUAGGA_READERS
        },
        locate: true
      },
      (err) => {
        if (err) {
          reject(err);
          return;
        }

        if (quaggaHandler) {
          window.Quagga.offDetected(quaggaHandler);
        }

        quaggaHandler = (result) => {
          const code = result?.codeResult?.code;
          if (!code) {
            return;
          }
          handleRawCode(code);
        };

        window.Quagga.onDetected(quaggaHandler);
        window.Quagga.start();

        scanningActive = true;
        setStatus("Kamera aktiv. Bücher nacheinander scannen.");
        resolve();
      }
    );
  });
}

function triggerPhotoScan() {
  if (!photoInput) {
    setStatus("Foto-Scan ist auf diesem Gerät nicht verfügbar.");
    return;
  }
  photoInput.click();
}

function onPhotoSelected(event) {
  const file = event?.target?.files?.[0];
  photoInput.value = "";

  if (!file) {
    return;
  }

  if (!window.Quagga) {
    setStatus("Foto-Scan nicht verfügbar. Bitte Seite neu laden.");
    return;
  }

  setStatus("Foto wird ausgewertet...");
  const objectUrl = URL.createObjectURL(file);

  window.Quagga.decodeSingle(
    {
      src: objectUrl,
      numOfWorkers: 0,
      inputStream: {
        size: 1400
      },
      locator: {
        patchSize: "large",
        halfSample: false
      },
      decoder: {
        readers: QUAGGA_READERS
      },
      locate: true
    },
    (result) => {
      URL.revokeObjectURL(objectUrl);
      const code = result?.codeResult?.code;
      if (!code) {
        setStatus("Kein Barcode im Foto erkannt. Bitte näher ran und scharf fotografieren.");
        return;
      }

      if (!handleRawCode(code)) {
        setStatus("Barcode erkannt, aber keine gültige ISBN.");
      }
    }
  );
}

function handleRawCode(rawValue) {
  const now = Date.now();
  if (now - lastScanAt < SCAN_COOLDOWN_MS) {
    return false;
  }

  const isbn = toIsbn13(rawValue);
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

function toIsbn13(value) {
  const candidates = getIsbnCandidates(value);
  for (const raw of candidates) {
    if (/^97[89]\d{10}$/.test(raw) && isValidIsbn13(raw)) {
      return raw;
    }

    if (/^\d{12}$/.test(raw)) {
      const repaired = `9${raw}`;
      if (/^97[89]\d{10}$/.test(repaired) && isValidIsbn13(repaired)) {
        return repaired;
      }
    }

    if (/^\d{9}[0-9X]$/.test(raw) && isValidIsbn10(raw)) {
      return convertIsbn10To13(raw);
    }
  }

  return null;
}

function getIsbnCandidates(value) {
  if (!value) {
    return [];
  }

  const text = String(value).toUpperCase();
  const compact = text.replace(/[^0-9X]/g, "");
  const seen = new Set();
  const out = [];

  const pushCandidate = (candidate) => {
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    out.push(candidate);
  };

  pushCandidate(compact);

  for (let i = 0; i <= compact.length - 13; i += 1) {
    pushCandidate(compact.slice(i, i + 13));
  }
  for (let i = 0; i <= compact.length - 12; i += 1) {
    pushCandidate(compact.slice(i, i + 12));
  }
  for (let i = 0; i <= compact.length - 10; i += 1) {
    pushCandidate(compact.slice(i, i + 10));
  }

  const directMatches = text.match(/97[89]\d{10}|\d{12}|\d{9}[0-9X]/g) || [];
  for (const match of directMatches) {
    pushCandidate(match);
  }

  return out;
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
  if (!window.Quagga) {
    return;
  }

  if (quaggaHandler) {
    window.Quagga.offDetected(quaggaHandler);
    quaggaHandler = null;
  }

  try {
    window.Quagga.stop();
  } catch {
    // Ignore stop errors.
  }
}
