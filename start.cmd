@echo off
rem Startet Minecraft Server Neo komplett in Docker: Server, Karte, API und Website.
rem Nach Code-Aenderungen werden die Container automatisch neu gebaut.
title Neo Start
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
  echo Docker Desktop laeuft nicht. Bitte zuerst Docker Desktop starten und warten, bis "Engine running" angezeigt wird.
  pause
  exit /b 1
)

rem Mod-Liste beim ersten Start anlegen (danach verwaltet sie die Website)
if not exist server\modrinth-projects.txt copy server\modrinth-projects.example.txt server\modrinth-projects.txt >nul

echo Container bauen und starten ...
docker compose up -d --build
if errorlevel 1 (
  echo Start fehlgeschlagen - Details oben.
  pause
  exit /b 1
)

echo Warte, bis die Website bereit ist ...
powershell -NoProfile -Command "for ($i = 0; $i -lt 90; $i++) { try { Invoke-WebRequest http://localhost:4200/api/health -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Seconds 2 } }; exit 1"
if errorlevel 1 (
  echo Website antwortet noch nicht. Logs ansehen mit: docker compose logs api web
  pause
  exit /b 1
)

start "" http://localhost:4200
echo.
echo Alles laeuft:
echo   Website    http://localhost:4200
echo   Karte      http://localhost:8100
echo   Minecraft  localhost  (Modrinth-Instanz "custom")
