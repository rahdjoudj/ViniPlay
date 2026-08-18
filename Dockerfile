# Stage 1: Builder
FROM ubuntu:26.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 26 and build essentials
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    gnupg \
    python3-setuptools && \
    curl -fsSL https://deb.nodesource.com/setup_26.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package*.json ./

# Install all dependencies (including dev for esbuild)
RUN npm install

# Copy application source
COPY . .

# Build frontend bundle
RUN npm run build:frontend

# Prune dev dependencies for final image
RUN npm prune --omit=dev

# ---

# Stage 2: Final Image
FROM ubuntu:26.04

ARG TARGETARCH

ENV NVIDIA_DRIVER_CAPABILITIES=all
ENV DEBIAN_FRONTEND=noninteractive
ENV LD_LIBRARY_PATH=/usr/lib/jellyfin-ffmpeg/lib
ENV NODE_ENV=production

# Install runtime: Node.js 26, Jellyfin FFmpeg, VA drivers
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ca-certificates \
    mesa-va-drivers && \
    curl -s https://repo.jellyfin.org/ubuntu/jellyfin_team.gpg.key | gpg --dearmor | tee /usr/share/keyrings/jellyfin.gpg >/dev/null && \
    echo "deb [arch=${TARGETARCH} signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/ubuntu resolute main" > /etc/apt/sources.list.d/jellyfin.list && \
    curl -fsSL https://deb.nodesource.com/setup_26.x | bash - && \
    apt-get install -y --no-install-recommends \
    jellyfin-ffmpeg7 \
    nodejs && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/bin/ffmpeg && \
    ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/bin/ffprobe && \
    ln -s /usr/lib/jellyfin-ffmpeg/vainfo /usr/bin/vainfo && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy application from builder stage
COPY --from=builder /usr/src/app .

EXPOSE 8998

RUN mkdir -p /data /dvr
VOLUME /data
VOLUME /dvr

CMD [ "node", "src/server.js" ]
