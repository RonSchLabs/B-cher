# ISBN Scanner (iPhone, offline)

## Was die App macht
- Kamera scannt fortlaufend ISBN-Barcodes (EAN-13, Präfix 978/979).
- Kein Klick pro Buch nötig: Buch vorhalten, warten auf Ton, nächstes Buch.
- Duplikate werden ignoriert.
- Speicherung lokal im Browser (`localStorage`).
- CSV-Export über Button `CSV exportieren`.

## Start lokal
1. Dateien auf einen Webspace legen (HTTPS) oder lokal per Server starten (`python3 -m http.server`).
2. Seite am iPhone in Safari öffnen.
3. Einmal `Kamera starten` tippen und Kamerazugriff erlauben.
4. Optional: Safari -> Teilen -> Zum Home-Bildschirm.

## Offline
- Nach dem ersten Laden ist die Seite per Service Worker offline verfügbar.
- Die erfassten ISBNs bleiben lokal auf dem Gerät gespeichert.

## CSV auf iCloud
- `CSV exportieren` erstellt eine Datei `isbn-scan-YYYY-MM-DD-HH-MM-SS.csv`.
- In Safari kannst du die Datei in "Dateien" sichern.
- Wenn dein iPhone so konfiguriert ist, landet sie in iCloud Drive.
