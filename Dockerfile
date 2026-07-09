# ── Backend image: API (runs the in-process pipeline) and/or worker ──────────
# Single image for both services; the running service is selected by the start
# command in railway.api.json / railway.worker.json. Build context = repo root.
FROM node:22-bookworm-slim

# Prisma needs openssl; ffmpeg-static / yt-dlp binaries are fetched by pnpm.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
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
