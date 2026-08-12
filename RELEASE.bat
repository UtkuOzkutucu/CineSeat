@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   CineSeat - yeni surum yayinlama
echo   ===============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [HATA] Node.js bulunamadi.
  echo.
  pause
  exit /b 1
)

rem Version arithmetic lives in tools\version.mjs, not inline here: a batch
rem for /f command is delimited by single quotes, so any quote in inline
rem JavaScript ends the command early and node gets a syntax error.
set CURRENT=
for /f "delims=" %%v in ('node tools\version.mjs') do set CURRENT=%%v
if not defined CURRENT (
  echo   [HATA] package.json okunamadi, surum numarasi alinamadi.
  echo.
  pause
  exit /b 1
)

echo   Su anki surum: !CURRENT!
echo.
echo   Bu surumde ne var?
echo.

set PATCH=
set MINOR=
set MAJOR=
for /f "delims=" %%v in ('node tools\version.mjs patch') do set PATCH=%%v
for /f "delims=" %%v in ('node tools\version.mjs minor') do set MINOR=%%v
for /f "delims=" %%v in ('node tools\version.mjs major') do set MAJOR=%%v

echo     [1] Duzeltme      ^( !CURRENT! -^> !PATCH! ^)
echo     [2] Yeni ozellik  ^( !CURRENT! -^> !MINOR! ^)
echo     [3] Buyuk surum   ^( !CURRENT! -^> !MAJOR! ^)
echo     [0] Vazgec
echo.
echo   Kac degisiklik yaptigin onemli degil - bir yayin, bir numara.
echo.

set CHOICE=
set /p CHOICE=  Secim (1/2/3/0):

set BUMP=
if "!CHOICE!"=="0" exit /b 0
rem One assignment per line, no parentheses: "set X=a& set Y=b )" stores the
rem space before the paren too, which would put a stray space in the filename.
if "!CHOICE!"=="1" set BUMP=patch
if "!CHOICE!"=="2" set BUMP=minor
if "!CHOICE!"=="3" set BUMP=major

if not defined BUMP (
  echo.
  echo   Gecersiz secim, hicbir sey yapilmadi.
  echo.
  pause
  exit /b 1
)

set NEXT=
for /f "delims=" %%v in ('node tools\version.mjs !BUMP!') do set NEXT=%%v
if not defined NEXT (
  echo.
  echo   [HATA] Yeni surum numarasi hesaplanamadi.
  echo.
  pause
  exit /b 1
)

echo.
echo   !CURRENT!  -^>  !NEXT!
echo.
set CONFIRM=
set /p CONFIRM=  Devam edilsin mi? (E/H):
if /i not "!CONFIRM!"=="E" (
  echo   Vazgecildi, surum numarasi degismedi.
  exit /b 0
)

echo.
echo   [1/2] Surum numarasi yaziliyor...
call npm version !BUMP! --no-git-tag-version
if errorlevel 1 (
  echo.
  echo   [HATA] Surum yazilamadi. Hicbir sey degismedi.
  pause
  exit /b 1
)

echo.
echo   [2/2] Kurulum dosyasi derleniyor (birkac dakika surebilir)...
call npm run dist
if errorlevel 1 (
  echo.
  echo   [HATA] Derleme basarisiz oldu.
  echo   Surum numarasi !NEXT! olarak yazildi - duzeltip tekrar
  echo   "npm run dist" calistirabilirsin.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo    Hazir. Simdi GitHub'da yeni bir release olustur:
echo.
echo      Etiket (tag) : v!NEXT!
echo      Dosya        : CineSeat-Setup-!NEXT!.exe
echo.
echo    Sadece bu tek dosyayi yukle. Etiket ile dosyadaki numara
echo    ayni olmali - uygulama guncellemeyi etikete bakarak buluyor.
echo   ============================================================
echo.
start "" "%~dp0dist"
pause
