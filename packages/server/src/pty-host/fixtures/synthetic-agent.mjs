#!/usr/bin/env node
/**
 * Proceso sintetico para pruebas de aceptacion de PTY persistente (Lane A).
 * Emite salida monotonica, maneja comandos de estado, captura SIGWINCH y reporta PID.
 */

import readline from 'node:readline';

const pid = process.pid;
let step = 0;
let jobToken = null;
let intervalTimer = null;

// Reportar arranque inmediato
process.stdout.write(`AGENT_READY pid=${pid}\n`);

// Manejar redimensionamiento de terminal
process.on('SIGWINCH', () => {
  const cols = process.stdout.columns || 0;
  const rows = process.stdout.rows || 0;
  process.stdout.write(`WINCH cols=${cols} rows=${rows}\n`);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();

  if (trimmed.startsWith('START_JOB')) {
    const match = trimmed.match(/token=([^\s]+)/);
    jobToken = match ? match[1] : 'default-token';
    step = 1;
    process.stdout.write(`JOB_STARTED token=${jobToken} step=${step}\n`);

    if (!intervalTimer) {
      intervalTimer = setInterval(() => {
        step++;
        process.stdout.write(`STEP ${step} token=${jobToken}\n`);
      }, 50);
      intervalTimer.unref();
    }
    return;
  }

  if (trimmed === 'CHECK_STATE') {
    process.stdout.write(`STATE_OK token=${jobToken} step=${step} pid=${pid}\n`);
    return;
  }

  if (trimmed.startsWith('PING')) {
    const arg = trimmed.slice(4).trim();
    process.stdout.write(`PONG ${arg} pid=${pid}\n`);
    return;
  }

  if (trimmed === 'FLOOD_1MB') {
    // Emitir 1 MiB de salida formateada
    const chunk = '0123456789abcdef'.repeat(64) + '\n'; // 1025 bytes per line
    for (let i = 0; i < 1024; i++) {
      process.stdout.write(chunk);
    }
    process.stdout.write('FLOOD_DONE\n');
    return;
  }

  if (trimmed.startsWith('EXIT_WITH')) {
    const code = parseInt(trimmed.slice(9).trim(), 10) || 0;
    process.stdout.write(`FINAL_ERROR_LINE code=${code}\n`);
    if (intervalTimer) clearInterval(intervalTimer);
    process.exit(code);
  }
});
