const express = require('express');
const fetch = require('node-fetch'); // Stelle sicher, dass node-fetch@2 installiert ist
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 8080;

// JSON-Body parsen
app.use(bodyParser.json());

// Arbeitsordner definieren
const uploadFolder = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder);
}

// Google Credentials einlesen
let serviceAccount;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log('✅ Google Credentials aus Umgebungsvariable geladen.');
  } catch (err) {
    throw new Error('❌ Fehler beim Parsen der GOOGLE_CREDENTIALS Umgebungsvariable.');
  }
} else {
  const serviceAccountPath = path.join(__dirname, 'credentials', 'client_secret.json');
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error('❌ Die Credentials-Datei wurde nicht gefunden und GOOGLE_CREDENTIALS ist nicht gesetzt.');
  }
  serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  console.log('✅ Google Credentials aus Datei geladen.');
}

// Erstelle einen JWT-Client für die Google Drive API
const jwtClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/drive.readonly']
);

jwtClient.authorize((err, tokens) => {
  if (err) {
    console.error('Fehler bei der Google Drive API Authentifizierung:', err);
  } else {
    console.log('Google Drive API authentifiziert!');
  }
});

// ------------------------------
// Hilfsfunktionen
// ------------------------------
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

// Diese Funktion ermittelt die Dauer eines Videos (in Sekunden) mittels ffprobe
async function getVideoDuration(filePath) {
  const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  const durationStr = await execPromise(cmd);
  return parseFloat(durationStr);
}

// ------------------------------
// Endpunkte
// ------------------------------

/**
 * POST /create-video
 * Erwartet einen JSON-Body mit Bild- und Audio-URLs in der Form:
 * {
 *   "imageURL1": "https://...",
 *   "audioURL1": "https://...",
 *   "imageURL2": "https://...",
 *   "audioURL2": "https://...",
 *   ...
 * }
 * Hier werden jeweils Teilvideos erstellt, die dann zusammengefügt werden.
 */
app.post('/create-video', async (req, res) => {
  try {
    let pairIndex = 1;
    const pairs = [];
    while (req.body[`imageURL${pairIndex}`] && req.body[`audioURL${pairIndex}`]) {
      pairs.push(pairIndex);
      pairIndex++;
    }
    if (pairs.length === 0) {
      return res.status(400).json({ error: "Keine gültigen Bild/Audio-Paare im Request-Body gefunden." });
    }
    const imagePaths = [];
    const audioPaths = [];
    for (const i of pairs) {
      const imageUrl = req.body[`imageURL${i}`];
      const audioUrl = req.body[`audioURL${i}`];
      const imgPath = path.join(uploadFolder, `image${i}.png`);
      const audPath = path.join(uploadFolder, `audio${i}.mp3`);
      console.log(`Lade Bild ${i} von URL: ${imageUrl}`);
      await downloadFile(imageUrl, imgPath);
      console.log(`Lade Audio ${i} von URL: ${audioUrl}`);
      await downloadFile(audioUrl, audPath);
      imagePaths.push(imgPath);
      audioPaths.push(audPath);
    }
    const videoParts = [];
    for (let i = 0; i < pairs.length; i++) {
      const outputVideo = path.join(uploadFolder, `video${i + 1}.mp4`);
      videoParts.push(outputVideo);
      // Das Bild wird geloopt, bis das Audio endet (-shortest)
      const cmd = `ffmpeg -y -loop 1 -i "${imagePaths[i]}" -i "${audioPaths[i]}" -c:v libx264 -c:a aac -b:a 192k -shortest -pix_fmt yuv420p "${outputVideo}"`;
      console.log(`Erstelle Teilvideo ${i + 1}: ${cmd}`);
      await execPromise(cmd);
    }
    const listFile = path.join(uploadFolder, 'list.txt');
    fs.writeFileSync(listFile, videoParts.map(v => `file '${v}'`).join('\n'));
    const finalVideo = path.join(uploadFolder, 'final_video.mp4');
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${finalVideo}"`;
    console.log("Führe Concatenation aus:", concatCmd);
    await execPromise(concatCmd);
    res.download(finalVideo, 'final_video.mp4', (downloadErr) => {
      if (downloadErr) {
        console.error('Fehler beim Senden des Videos:', downloadErr);
      }
      // Aufräumen der temporären Dateien
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
 * POST /create-single-video
 * Erwartet einen JSON-Body mit:
 * {
 *   "imageURL": "https://...",
 *   "audioURL": "https://..."
 * }
 * Erstellt ein Video, bei dem das Bild für die Dauer des Audios angezeigt wird.
 * Anschließend wird das Video um 2,3 Sekunden am Ende gekürzt.
 */
app.post('/create-single-video', async (req, res) => {
  try {
    const { imageURL, audioURL } = req.body;
    if (!imageURL || !audioURL) {
      return res.status(400).json({ error: "Es müssen sowohl imageURL als auch audioURL angegeben werden." });
    }
    const imagePath = path.join(uploadFolder, 'single_image.png');
    const audioPath = path.join(uploadFolder, 'single_audio.mp3');
    let videoPath = path.join(uploadFolder, 'single_video.mp4');
    console.log(`Lade Bild von URL: ${imageURL}`);
    await downloadFile(imageURL, imagePath);
    console.log(`Lade Audio von URL: ${audioURL}`);
    await downloadFile(audioURL, audioPath);
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -c:a aac -b:a 192k -shortest -pix_fmt yuv420p "${videoPath}"`;
    console.log(`Erstelle Einzelvideo: ${cmd}`);
    await execPromise(cmd);

    // Video trimmen: Entferne die letzten 2,3 Sekunden
    const originalDuration = await getVideoDuration(videoPath);
    const newDuration = originalDuration - 2.3;
    if (newDuration > 0) {
      const trimmedVideoPath = path.join(uploadFolder, 'single_video_trimmed.mp4');
      const trimCmd = `ffmpeg -y -i "${videoPath}" -t ${newDuration} -c copy "${trimmedVideoPath}"`;
      console.log(`Trimpe das Video auf ${newDuration} Sekunden: ${trimCmd}`);
      await execPromise(trimCmd);
      // Altes Video löschen und Variable aktualisieren
      fs.unlink(videoPath, (err) => {
        if (err) {
          console.warn('Konnte das ursprüngliche Video nicht löschen:', videoPath, err);
        }
      });
      videoPath = trimmedVideoPath;
    }

    res.download(videoPath, 'single_video.mp4', (downloadErr) => {
      if (downloadErr) {
        console.error('Fehler beim Senden des Videos:', downloadErr);
      }
      // Temporäre Dateien löschen
      const filesToDelete = [imagePath, audioPath, videoPath];
      filesToDelete.forEach(filePath => {
        fs.unlink(filePath, (err) => {
          if (err) {
            console.warn('Konnte Datei nicht löschen:', filePath, err);
          }
        });
      });
    });
  } catch (error) {
    console.error("Fehler im /create-single-video Endpoint:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /merge-videos
 * Erwartet einen JSON-Body mit den Feldern:
 * {
 *   "videoURL1": "https://...",
 *   "videoURL2": "https://...",
 *   "videoURL3": "https://...",
 *   "videoURL4": "https://...",
 *   "videoURL5": "https://...",
 *   "videoURL6": "https://..."
 * }
 * Lädt die sechs Videos herunter und fügt sie nahtlos zu einem finalen Video zusammen,
 * wobei die Videos neu kodiert werden, um eine exakte Synchronisation von Bild und Ton zu gewährleisten.
 */
app.post('/merge-videos', async (req, res) => {
  try {
    const videoUrls = [];
    for (let i = 1; i <= 6; i++) {
      const url = req.body[`videoURL${i}`];
      if (!url) {
        return res.status(400).json({ error: `videoURL${i} fehlt im Request-Body.` });
      }
      videoUrls.push(url);
    }
    const downloadedVideos = [];
    for (let i = 0; i < videoUrls.length; i++) {
      const videoPath = path.join(uploadFolder, `merge_video${i + 1}.mp4`);
      console.log(`Lade Video ${i + 1} von URL: ${videoUrls[i]}`);
      await downloadFile(videoUrls[i], videoPath);
      downloadedVideos.push(videoPath);
    }
    const listFile = path.join(uploadFolder, 'merge_list.txt');
    fs.writeFileSync(listFile, downloadedVideos.map(v => `file '${v}'`).join('\n'));
    const finalMergePath = path.join(uploadFolder, 'final_merged_video.mp4');
    // Neu kodieren, damit die Zeitstempel neu gesetzt werden und Bild & Ton exakt hintereinander laufen
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -c:a aac -b:a 192k "${finalMergePath}"`;
    console.log(`Führe Zusammenfügen der Videos aus: ${cmd}`);
    await execPromise(cmd);
    res.download(finalMergePath, 'final_merged_video.mp4', (downloadErr) => {
      if (downloadErr) {
        console.error('Fehler beim Senden des zusammengefügten Videos:', downloadErr);
      }
      const filesToDelete = [...downloadedVideos, listFile, finalMergePath];
      filesToDelete.forEach(filePath => {
        fs.unlink(filePath, (err) => {
          if (err) {
            console.warn('Konnte Datei nicht löschen:', filePath, err);
          }
        });
      });
    });
  } catch (error) {
    console.error("Fehler im /merge-videos Endpoint:", error);
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
