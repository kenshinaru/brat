import os
import hashlib
import asyncio
import shutil
import time
from typing import Optional
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from playwright.async_api import async_playwright
from lru import LRU

app = FastAPI()

TEMP_DIR = "temp"
os.makedirs(TEMP_DIR, exist_ok=True)

image_cache = LRU(100)
video_cache = LRU(50)

BROWSER = None

def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()

async def launch_browser():
    global BROWSER
    if not BROWSER:
        playwright = await async_playwright().start()
        BROWSER = await playwright.chromium.launch()

async def fetch_image(text: str, index: int = 0) -> str:
    await launch_browser()
    context = await BROWSER.new_context(viewport={"width": 1536, "height": 695})
    page = await context.new_page()
    file_path = os.path.abspath("site/index.html")

    await page.goto(f"file://{file_path}")
    await page.click('#toggleButtonWhite')
    await page.click('#textOverlay')
    await page.click('#textInput')
    await page.fill('#textInput', text)

    element = await page.query_selector('#textOverlay')
    box = await element.bounding_box()

    image_path = os.path.join(TEMP_DIR, f"brat_{int(time.time())}_{index}.png")
    await page.screenshot(path=image_path, clip={
        "x": box["x"],
        "y": box["y"],
        "width": 500,
        "height": 500
    })

    await context.close()
    return image_path

@app.get("/")
async def generate(text: str = Query(...), video: Optional[bool] = False):
    key = hash_text(text)

    if not video:
        if key in image_cache and os.path.exists(image_cache[key]):
            return FileResponse(image_cache[key], media_type="image/png")

        try:
            image_path = await fetch_image(text)
            image_cache[key] = image_path
            return FileResponse(image_path, media_type="image/png")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    if key in video_cache and os.path.exists(video_cache[key]):
        return FileResponse(video_cache[key], media_type="video/mp4")

    words = text.split()
    frames = []

    try:
        for i in range(min(len(words), 40)):
            current_text = " ".join(words[:i+1])
            frame_path = await fetch_image(current_text, i)
            frames.append(frame_path)

        if not frames:
            raise ValueError("Gagal membuat gambar")

        filelist_path = os.path.join(TEMP_DIR, "filelist.txt")
        with open(filelist_path, "w") as f:
            for frame in frames:
                f.write(f"file '{frame}'\nduration 0.7\n")
            f.write(f"file '{frames[-1]}'\nduration 2\n")

        output_path = os.path.join(TEMP_DIR, f"brat_{int(time.time())}.mp4")
        ffmpeg_cmd = f"ffmpeg -y -f concat -safe 0 -i {filelist_path} -vf fps=30,scale=512:512 -c:v libx264 -preset ultrafast -pix_fmt yuv420p {output_path}"
        proc = await asyncio.create_subprocess_shell(ffmpeg_cmd)
        await proc.communicate()

        for frame in frames:
            if os.path.exists(frame):
                os.remove(frame)
        os.remove(filelist_path)

        video_cache[key] = output_path
        return FileResponse(output_path, media_type="video/mp4")

    except Exception as e:
        for frame in frames:
            if os.path.exists(frame):
                os.remove(frame)
        raise HTTPException(status_code=500, detail=str(e))
