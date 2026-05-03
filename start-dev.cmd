@echo off
REM ----------------------------------------------------------------------
REM  start-dev.cmd
REM
REM  Launches the full NoteControl development stack in two separate
REM  windows, then opens the browser. Replaces the "press F5" flow when
REM  the .esproj approach isn't available on your Visual Studio install.
REM
REM  Usage: double-click this file, or run it from any prompt.
REM
REM  What it does:
REM    1. Starts the ASP.NET Core backend with `dotnet run` in a new
REM       window (port 8080).
REM    2. Starts the Vite frontend dev server with `npm run dev` in a
REM       second new window (port 5173).
REM    3. Vite's server.open setting takes care of launching the browser
REM       at http://127.0.0.1:5173/ when it's ready.
REM
REM  To stop everything: close both windows. (Ctrl+C inside each window
REM  works too. There's no shared shutdown — each is independent.)
REM
REM  Notes:
REM    - Run `npm install` in src\NoteControl.Frontend once before first
REM       use. This script doesn't auto-install dependencies.
REM    - If port 5173 or 8080 is already in use, the corresponding
REM       window will show an error and close on Enter.
REM    - The "start" command opens a new cmd window per process so you
REM       can see logs from each independently.
REM ----------------------------------------------------------------------

setlocal

REM Resolve the script's own directory so we work regardless of where
REM the user double-clicked from.
set SCRIPT_DIR=%~dp0
set SERVER_DIR=%SCRIPT_DIR%src\NoteControl.Server
set FRONTEND_DIR=%SCRIPT_DIR%src\NoteControl.Frontend

if not exist "%SERVER_DIR%\NoteControl.Server.csproj" (
    echo ERROR: Could not find NoteControl.Server.csproj at %SERVER_DIR%
    echo Make sure this script is in the repository root next to NoteControl.sln.
    pause
    exit /b 1
)

if not exist "%FRONTEND_DIR%\package.json" (
    echo ERROR: Could not find package.json at %FRONTEND_DIR%
    pause
    exit /b 1
)

if not exist "%FRONTEND_DIR%\node_modules" (
    echo.
    echo node_modules is missing. Running ^`npm install^` first...
    echo.
    pushd "%FRONTEND_DIR%"
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Aborting.
        popd
        pause
        exit /b 1
    )
    popd
)

echo.
echo Launching NoteControl backend in a new window...
start "NoteControl.Server" cmd /k "cd /d %SERVER_DIR% && dotnet run"

echo Launching NoteControl frontend dev server in a new window...
start "NoteControl.Frontend (Vite)" cmd /k "cd /d %FRONTEND_DIR% && npm run dev"

echo.
echo Both processes are starting. The browser should open automatically
echo at http://127.0.0.1:5173/ once Vite is ready (a few seconds).
echo.
echo If the browser opens before the backend is ready you'll see a
echo "server unreachable" error on the login page; just refresh once.
echo.
echo Close the two new windows to stop the dev stack.
echo.
endlocal
