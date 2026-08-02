@echo off
setlocal
cd /d "%~dp0"

echo.
echo   CineSeat - kurulum dosyasi olusturuluyor
echo   =======================================
echo.
echo   Bunu yalnizca BIR KEZ calistirmaniz yeterli.
echo   Sonrasinda uygulamayi Baslat menusunden veya
echo   masaustu kisayolundan acabilirsiniz.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [HATA] Node.js bulunamadi.
  echo   https://nodejs.org adresinden kurup tekrar deneyin.
  echo.
  pause
  exit /b 1
)

echo   [1/2] Bagimliliklar yukleniyor...
call npm install
if errorlevel 1 (
  echo.
  echo   [HATA] npm install basarisiz oldu.
  pause
  exit /b 1
)

echo.
echo   [2/2] Kurulum dosyasi derleniyor (birkac dakika surebilir)...
call npm run dist
if errorlevel 1 (
  echo.
  echo   [HATA] Derleme basarisiz oldu.
  pause
  exit /b 1
)

echo.
echo   Bitti. "dist" klasorundeki
echo   "CineSeat-Setup-*.exe" dosyasini calistirin.
echo.
start "" "%~dp0dist"
pause
