# ── Backend image: API (runs the in-process pipeline) and/or worker ──────────
# Single image for both services; the running service is selected by the start
# command in railway.api.json / railway.worker.json. Build context = repo root.
FROM node:22-bookworm-slim

# - openssl: required by Prisma
# - python3 / python-is-python3: youtube-dl-exec's install needs Python, and the
#   downloaded yt-dlp is a Python zipapp that needs python3 at runtime too.
# - ffmpeg-static provides its own ffmpeg binary (no apt ffmpeg needed).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

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
