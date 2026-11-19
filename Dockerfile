# Stage 1: Build the Vite production frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: High-performance lightweight runner
FROM node:20-alpine
WORKDIR /app

# Install ffmpeg for optional HEVC -> H.264 transcoding in go2rtc
RUN apk add --no-cache ffmpeg

# Install only production-grade node modules
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code and the compiled frontend dist assets
COPY server.js onvifBridge.js ./
COPY --from=builder /app/dist ./dist

# Copy the statically-linked go2rtc binary and ensure executable permissions
COPY go2rtc ./go2rtc
RUN chmod +x go2rtc

# Expose application, RTSP, and ONVIF bridge ports
EXPOSE 3000 8554 8901

# Define mountable data volume for persistent configs (go2rtc.yaml)
VOLUME ["/app/data"]

# Default operational environment configs
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV NODE_ENV=production

# Start single-entrypoint application server
CMD ["node", "server.js"]
