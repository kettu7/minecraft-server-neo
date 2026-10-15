# API für Minecraft Server Neo (Node 24 führt TypeScript direkt aus)
FROM node:24-alpine
# GNU tar für die Backups (busybox-tar kennt nicht alle Optionen)
RUN apk add --no-cache tar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data BACKUP_DIR=/backups MC_DATA_DIR=/mc
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.ts"]
