import { spawn } from 'node:child_process';

const parsedDelay = Number.parseInt(process.env.BOT_RESTART_DELAY_MS || '5000', 10);
const restartDelayMs = Number.isFinite(parsedDelay)
  ? Math.max(1000, Math.min(parsedDelay, 60000))
  : 5000;

let child = null;
let stopping = false;
let restartTimer = null;
let forceStopTimer = null;

function startBot() {
  if (stopping) return;

  console.log('[watchdog] Starting WA-MV-Bot...');
  const currentChild = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    env: process.env
  });
  child = currentChild;

  currentChild.on('error', (error) => {
    console.error('[watchdog] Could not start the bot process:', error.message);
  });

  currentChild.on('close', (code, signal) => {
    if (child === currentChild) child = null;

    if (stopping) {
      if (forceStopTimer) clearTimeout(forceStopTimer);
      process.exitCode = 0;
      return;
    }

    const result = signal ? `signal ${signal}` : `exit code ${code}`;
    console.error(
      `[watchdog] Bot stopped (${result}). Restarting in ${Math.ceil(restartDelayMs / 1000)} seconds...`
    );
    restartTimer = setTimeout(startBot, restartDelayMs);
  });
}

function stopBot(signal) {
  if (stopping) return;
  stopping = true;

  if (restartTimer) clearTimeout(restartTimer);
  console.log(`[watchdog] Received ${signal}; stopping without restarting.`);

  if (!child) {
    process.exit(0);
    return;
  }

  child.kill(signal);
  forceStopTimer = setTimeout(() => {
    if (child) {
      console.error('[watchdog] Bot did not stop cleanly; forcing shutdown.');
      child.kill('SIGKILL');
    }
  }, 10000);
  forceStopTimer.unref();
}

process.on('SIGINT', () => stopBot('SIGINT'));
process.on('SIGTERM', () => stopBot('SIGTERM'));

startBot();
