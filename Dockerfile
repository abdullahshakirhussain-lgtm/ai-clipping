# ── Backend image: API (runs the in-process pipeline) and/or worker ──────────
# Single image for both services; the running service is selected by the start
# command in railway.api.json / railway.worker.json. Build context = repo root.
FROM node:22-bookworm-slim

# - openssl: required by Prisma
# - python3 / python-is-python3: youtube-dl-exec's install needs Python, and the
#   downloaded yt-dlp is a Python zipapp that needs python3 at runtime too.
# - curl / unzip: to fetch the deno runtime below.
# - ffmpeg-static provides its own ffmpeg binary (no apt ffmpeg needed).
# - fontconfig + fonts-liberation: WITHOUT these, ffmpeg's libass has no font to
#   render burned-in captions, so clips come out with the subtitles silently
#   dropped. fontconfig aliases "Arial" (our caption style) -> Liberation Sans.
# - libgomp1: OpenMP runtime required by onnxruntime-node (face-detection for the
#   opt-in reframing); without it onnxruntime fails to load and reframing silently
#   falls back to the center crop.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 python-is-python3 curl unzip fontconfig fonts-liberation libgomp1 \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

# deno: yt-dlp needs a JavaScript runtime to extract video formats from sites
# whose players require JS (Vimeo and many others). Without it yt-dlp can only
# get audio. yt-dlp auto-detects deno on PATH.
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/deno \
  && rm /tmp/deno.zip

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Copy the whole workspace (node_modules excluded via .dockerignore) and install.
# allowBuilds in pnpm-workspace.yaml lets ffmpeg-static / esbuild / prisma /
# youtube-dl-exec run their install scripts here.
COPY . .
RUN pnpm install --frozen-lockfile

# Generate the Prisma client for the Linux runtime.
RUN pnpm --filter @clipfactory/db exec prisma generate

# Runtime after install so devDeps (tsx, prisma CLI) are present for start/migrate.
ENV NODE_ENV=production
EXPOSE 3001

# Overridden per service by railway.*.json; sensible default = API.
CMD ["pnpm", "--filter", "@clipfactory/api", "start"]
