@echo off
cd /d "%~dp0"
echo Starting Binance leader tracker...
echo Open http://127.0.0.1:8790/ in your browser after the server starts.
node binance_leader_poller.js
pause
