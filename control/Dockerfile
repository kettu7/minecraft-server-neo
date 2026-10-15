# neo-control: Steuerdienst mit Docker-Zugriff (nur für den Minecraft-Container)
FROM node:24-alpine
RUN apk add --no-cache tar
WORKDIR /app
COPY src ./src
EXPOSE 4000
CMD ["node", "src/server.ts"]
