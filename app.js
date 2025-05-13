import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, unlinkSync } from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const TEMP_DIR = path.join(__dirname, 'temp');
await fs.mkdir(TEMP_DIR, { recursive: true });

const imageCache = new LRUCache({ max: 100, ttl: 1000 * 60 * 60 }); // 1 jam
const videoCache = new LRUCache({ max: 50, ttl: 1000 * 60 * 60 });  // 1 jam

const hashText = (text) => crypto.createHash('sha256').update(text).digest('hex');

app.use(morgan('dev'));

let browser;
const launchBrowser = async () => {
  if (!browser) browser = await chromium.launch();
};
await launchBrowser();

async function fetchImage(text, outputPath) {
  await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1536, height: 695 } });
  const page = await context.newPage();
  const filePath = path.join(__dirname, './site/index.html');

  await page.goto(`file://${filePath}`);
  await page.click('#toggleButtonWhite');
  await page.click('#textOverlay');
  await page.click('#textInput');
  await page.fill('#textInput', text);

  const element = await page.$('#textOverlay');
  const box = await element.boundingBox();

  await page.screenshot({
    clip: {
      x: box.x,
      y: box.y,
      width: 500,
      height: 500
    },
    path: outputPath
  });

  await context.close();
}

app.get('/', async (req, res) => {
  const text = req.query.text;
  const isVideo = req.query.video === 'true';

  if (!text) { 
    const json = await (await fetch('http://ip-api.com/json')).json()
    return res.json({
            status: true,
            msg: 'Parameter text diperlukan',
            data: json
    });
  }

  const key = hashText(text);

  if (!isVideo) {
    const cachedPath = imageCache.get(key);
    if (cachedPath) {
      console.log(`[CACHE] - Mengirim gambar`);
      return res.sendFile(cachedPath);
    }

    try {
      const imagePath = path.join(TEMP_DIR, `${key}.png`);
      if (existsSync(imagePath)) {
        imageCache.set(key, imagePath);
        console.log(`[FS] - Mengirim gambar`);
        return res.sendFile(imagePath);
      }

      await fetchImage(text, imagePath);
      imageCache.set(key, imagePath);
      res.setHeader('Content-Type', 'image/png');
      console.log(`[GENERATE] - Mengirim gambar`);
      return res.sendFile(imagePath);
    } catch (err) {
      return res.status(500).json({ error: 'Gagal menghasilkan gambar', details: err.message });
    }
  }

  const cachedVideo = videoCache.get(key);
  if (cachedVideo) {
    console.log(`[CACHE] - Mengirim video`);
    return res.sendFile(cachedVideo);
  }
  
  const words = text.split(' ').slice(0, 40);
  const framePaths = [];
  
  try {
    const context = await browser.newContext({ viewport: { width: 1536, height: 695 } });
    const page = await context.newPage();
    const filePath = path.join(__dirname, './site/index.html');
    
    await page.goto(`file://${filePath}`);
    await page.click('#toggleButtonWhite');
    await page.click('#textOverlay');
    await page.click('#textInput');

    for (let i = 0; i < words.length; i++) {
      const currentText = words.slice(0, i + 1).join(' ');
      const framePath = path.join(TEMP_DIR, `${key}_${i}.png`);
      await page.fill('#textInput', currentText);
      const element = await page.$('#textOverlay');
      const box = await element.boundingBox();
      await page.screenshot({
        clip: {
          x: box.x,
          y: box.y,
          width: 500,
          height: 500
        },
        path: framePath
      });
      framePaths.push(framePath);
    }

    await context.close();

    const listName = `filelist_${Date.now()}.txt`;
    const fileListPath = path.join(TEMP_DIR, listName);
    const listData = framePaths.map(p => `file '${p}'\nduration 0.7`).join('\n') +
                     `\nfile '${framePaths.at(-1)}'\nduration 2`;

    await fs.writeFile(fileListPath, listData);

    const videoOutputPath = path.join(TEMP_DIR, `${key}.mp4`);
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${fileListPath}" -vf "fps=30,scale=512:512" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${videoOutputPath}"`;

    exec(ffmpegCmd, async (err) => {
      await fs.unlink(fileListPath).catch(() => {});
      framePaths.forEach(fp => existsSync(fp) && unlinkSync(fp));

      if (err) {
        console.error('FFmpeg error:', err);
        return res.status(500).json({ error: 'Gagal membuat video' });
      }

      videoCache.set(key, videoOutputPath);
      res.setHeader('Content-Type', 'video/mp4');
      console.log(`[GENERATE] - Mengirim video`);
      res.sendFile(videoOutputPath);
    });

  } catch (err) {
    framePaths.forEach(fp => existsSync(fp) && unlinkSync(fp));
    res.status(500).json({ error: 'Gagal memproses video', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
