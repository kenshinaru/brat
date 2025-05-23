import { Hono } from 'hono'
import { chromium } from 'playwright'
import fs from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { exec } from 'child_process'
import { fileURLToPath } from 'url'
import { LRUCache } from 'lru-cache'

const app = new Hono()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TEMP_DIR = path.join(__dirname, 'temp')

await fs.mkdir(TEMP_DIR, { recursive: true })

const cache = new LRUCache({ max: 100, ttl: 1000 * 60 * 60 })
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex')
const browser = await chromium.launch()

app.get('/', async (c) => {
  const text = c.req.query('text')
  const isVideo = c.req.query('video') === 'true'
  if (!text) return c.json({ error: 'Parameter text diperlukan' }, 400)

  const key = hash(text)
  const cached = cache.get(key)
  if (cached && existsSync(cached)) {
    return c.body(await fs.readFile(cached), 200, {
      'Content-Type': isVideo ? 'video/mp4' : 'image/png'
    })
  }

  const file = path.join(__dirname, 'site/index.html')
  const context = await browser.newContext({ viewport: { width: 1536, height: 695 } })
  const page = await context.newPage()
  await page.goto(`file://${file}`)
  await page.click('#toggleButtonWhite')
  await page.click('#textOverlay')
  await page.click('#textInput')

  if (!isVideo) {
    const outPath = path.join(TEMP_DIR, `${key}.png`)
    await page.fill('#textInput', text)
    const box = await (await page.$('#textOverlay')).boundingBox()
    await page.screenshot({ clip: { ...box, width: 500, height: 500 }, path: outPath })
    await context.close()
    cache.set(key, outPath)
    return c.body(await fs.readFile(outPath), 200, { 'Content-Type': 'image/png' })
  }

  const words = text.split(' ').slice(0, 40)
  const frames = []
  for (let i = 0; i < words.length; i++) {
    const txt = words.slice(0, i + 1).join(' ')
    const frame = path.join(TEMP_DIR, `${key}_${i}.png`)
    await page.fill('#textInput', txt)
    const box = await (await page.$('#textOverlay')).boundingBox()
    await page.screenshot({ clip: { ...box, width: 500, height: 500 }, path: frame })
    frames.push(frame)
  }
  await context.close()

  const listPath = path.join(TEMP_DIR, `list_${Date.now()}.txt`)
  const outPath = path.join(TEMP_DIR, `${key}.mp4`)
  const list = frames.map(f => `file '${f}'\nduration 0.7`).join('\n') + `\nfile '${frames.at(-1)}'\nduration 2`
  await fs.writeFile(listPath, list)

  const ffmpeg = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -vf "fps=30,scale=512:512" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${outPath}"`
  return new Promise((resolve) => {
    exec(ffmpeg, async (err) => {
      await fs.unlink(listPath).catch(() => {})
      frames.forEach(f => existsSync(f) && unlinkSync(f))
      if (err) return resolve(c.json({ error: 'Gagal membuat video' }, 500))
      cache.set(key, outPath)
      resolve(c.body(await fs.readFile(outPath), 200, { 'Content-Type': 'video/mp4' }))
    })
  })
})

serve({ fetch: app.fetch, port: process.env.PORT || 3000 })
console.log('Server ready')
