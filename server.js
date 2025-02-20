const express = require('express');
const fetch = require('node-fetch'); // Stelle sicher, dass node-fetch@2 installiert ist
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

// ------------------------------
// Google Drive Credentials einbinden
// ------------------------------
const { google } = require('googleapis');
// Definiere den Pfad zur Credentials-Datei (die Datei MUSS im Ordner "credentials" liegen und in der .gitignore stehen!)
const serviceAccountPath = path.join(__dirname, 'credentials', 'client_secret_432588095707-...apps.googleusercontent.com.json');
if (!fs.existsSync(serviceAccountPath)) {
  throw new Error('Die Credentials-Datei wurde nicht gefunden.');
}
// Lade die Credentials aus der Datei
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// Erstelle einen JWT-Client für den Zugriff auf die Google Drive API
const jwtClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/drive.readonly']
);

jwtClient.authorize((err, tokens) => {
  if (err) {
    console.error('Fehler bei der Google Drive API Authentifizierung:', err);
    // Im Fehlerfall läuft der Server weiter – du kannst hier auch den Prozess beenden, falls nötig.
  } else {
    console.log('Google Drive API authentifiziert!');
  }
});

// ------------------------------
// Express-Server Setup
// ------------------------------
const app = express();
const port = process.env.PORT || 8080;

// Parse JSON-Body (für Requests mit JSON, z.B. mit den URLs)
app.use(bodyParser.json());

// Definiere den Arbeits-/Upload-Ordner
const uploadFolder = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder);
}

/**
 * Hilfsfunktion: Führt einen Shell-Befehl aus und gibt ein Promise zurück.
 */
function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      resolve(stdout || stderr);
    });
  });
}

/**
 * Hilfsfunktion: Lädt eine Datei von einer URL herunter und speichert sie unter destPath.
 */
async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download-Fehler für ${url}: ${response.statusText}`);
  }
  const buffer = await response.buffer();
  fs.writeFileSync(destPath, buffer);
  console.log(`Datei von ${url} heruntergeladen in ${destPath}`);
  return destPath;
}

/**
 * POST /create-video
 * Erwartet einen JSON-Body mit Feldern:
 * {
 *   "imageURL1": "https://...",
 *   "audioURL1": "https://...",
 *   "imageURL2": "https://...",
 *   "audioURL2": "https://...",
 *   ...
 *   "imageURL6": "https://...",
 *   "audioURL6": "https://..."
 * }
 * Die URLs sollten direkt auf die Dateien verweisen (z.B. Google Drive Download-Links, die mit export=download arbeiten).
 */
app.post('/create-video', async (req, res) => {
  try {
    // Überprüfe, ob alle benötigten Felder vorhanden sind
    const expectedFields = [];
    for (let i = 1; i <= 6; i++) {
      expectedFields.push(`imageURL${i}`, `audioURL${i}`);
    }
    const missingFields = expectedFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Es fehlen einige Felder im Request-Body.',
        missingFields
      });
    }
    
    // Erstelle Arrays für die lokalen Dateipfade
    const imagePaths = [];
    const audioPaths = [];
    
    // Lade alle Dateien von den übergebenen URLs herunter
    for (let i = 1; i <= 6; i++) {
      const imageUrl = req.body[`imageURL${i}`];
      const audioUrl = req.body[`audioURL${i}`];
      
      // Bestimme lokale Dateinamen; für Bilder verwenden wir .png, für Audios .mp3
      const imgPath = path.join(uploadFolder, `image${i}.png`);
      const audPath = path.join(uploadFolder, `audio${i}.mp3`);
      
      console.log(`Lade Bild ${i} von URL: ${imageUrl}`);
      await downloadFile(imageUrl, imgPath);
      console.log(`Lade Audio ${i} von URL: ${audioUrl}`);
      await downloadFile(audioUrl, audPath);
      
      imagePaths.push(imgPath);
      audioPaths.push(audPath);
    }
    
    // Erstelle für jedes Bild-Audio-Paar ein kurzes Teilvideo
    const videoParts = [];
    for (let i = 0; i < 6; i++) {
      const outputVideo = path.join(uploadFolder, `video${i + 1}.mp4`);
      videoParts.push(outputVideo);
      
      // FFmpeg-Befehl: Das Bild wird als statisches Bild verwendet, bis das Audio endet.
      const cmd = `ffmpeg -y -loop 1 -i "${imagePaths[i]}" -i "${audioPaths[i]}" -c:v libx264 -c:a aac -b:a 192k -shortest -pix_fmt yuv420p "${outputVideo}"`;
      console.log(`Erstelle Teilvideo ${i+1}: ${cmd}`);
      await execPromise(cmd);
    }
    
    // Erstelle eine Liste der Teilvideos für die Zusammenfügung
    const listFile = path.join(uploadFolder, 'list.txt');
    fs.writeFileSync(listFile, videoParts.map(v => `file '${v}'`).join('\n'));
    
    // Führe FFmpeg aus, um das finale Video zusammenzufügen
    const finalVideo = path.join(uploadFolder, 'final_video.mp4');
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalVideo}"`;
    console.log("Führe Concatenation aus:", concatCmd);
    await execPromise(concatCmd);
    
    // Sende das finale Video als Download zurück
    res.download(finalVideo, 'final_video.mp4', (downloadErr) => {
      if (downloadErr) {
        console.error('Fehler beim Senden des Videos:', downloadErr);
      }
      // Optional: Lösche alle temporären Dateien
      const filesToDelete = [...imagePaths, ...audioPaths, ...videoParts, listFile, finalVideo];
      filesToDelete.forEach(filePath => {
        fs.unlink(filePath, (err) => {
          if (err) {
            console.warn('Konnte Datei nicht löschen:', filePath, err);
          }
        });
      });
    });
    
  } catch (error) {
    console.error("Fehler im /create-video Endpoint:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /ffmpeg-version
 * Gibt die installierte FFmpeg-Version zurück.
 */
app.get('/ffmpeg-version', (req, res) => {
  exec('ffmpeg -version', (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send(`Fehler: ${error.message}`);
    }
    res.type('text/plain').send(stdout);
  });
});

app.listen(port, () => {
  console.log(`FFmpeg-Service läuft auf Port ${port}`);
});
