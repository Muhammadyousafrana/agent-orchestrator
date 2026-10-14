/**
 * Process Runner Module
 *
 * Wraps child_process.spawn to manage CLI agent sub-processes with
 * timeout handling, streaming output, stdin input, and cross-platform
 * process-tree killing.
 */

'use strict';

const { spawn, exec } = require('child_process');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes hard max
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes without output

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class ProcessRunner {
  /**
   * @param {string}   command          - The CLI command to execute.
   * @param {string[]} args             - Arguments to pass to the command.
 * @param {Object}   [options]
 * @param {string}   [options.cwd]    - Working directory (defaults to process.cwd()).
 * @param {number}   [options.timeout]- Hard max runtime in ms (defaults to 60 min).
 * @param {number}   [options.idleTimeout]- Max time without output in ms (defaults to 15 min).
 * @param {boolean}  [options.keepStdinOpen] - Keep stdin open for interactive prompts.
 */
  constructor(command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.cwd = options.cwd || process.cwd();
    this.timeout = options.timeout ?? parsePositiveInt(process.env.AGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.idleTimeout = options.idleTimeout ?? parsePositiveInt(process.env.AGENT_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
    this.keepStdinOpen = options.keepStdinOpen ?? true;

    /** @type {import('child_process').ChildProcess|null} */
    this.process = null;
    this.killed = false;
    this.output = '';
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Spawn the process and stream output through the provided callback.
   *
   * @param {(stream: 'stdout'|'stderr', data: string) => void} [onData]
   * @returns {Promise<{exitCode: number|null, output: string, killed: boolean}>}
   */
  run(onData) {
    return new Promise((resolve, reject) => {
      const isWindows = os.platform() === 'win32';

      if (isWindows) {
        // On Windows, build a single command string to avoid DEP0190
        // deprecation warning (args + shell:true is unsafe). We quote
        // each argument so cmd.exe treats it as a single token.
        const quoteToken = (value) => {
          // Replace newlines with spaces for CLI compatibility, then
          // escape internal double-quotes and wrap in double-quotes.
          const sanitised = String(value).replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
          return `"${sanitised}"`;
        };
        const quotedArgs = this.args.map((a) => quoteToken(a));
        const fullCmd = [quoteToken(this.command), ...quotedArgs].join(' ');

        this.process = spawn(fullCmd, [], {
          cwd: this.cwd,
          shell: true,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        this.process = spawn(this.command, this.args, {
          cwd: this.cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      // Some local agent CLIs ask for approval while running. Keep stdin open
      // by default so the UI can forward the user's response to the process.
      if (!this.keepStdinOpen && this.process.stdin) {
        this.process.stdin.end();
      }

      // -- Timeout handling ------------------------------------------------
      let maxTimer = null;
      let idleTimer = null;
      let settled = false;

      const failWithTimeout = (kind, ms) => {
        if (settled) return;
        settled = true;
        this.killed = true;
        this.kill();
        const err = new Error(`Process ${kind} timed out after ${ms} ms`);
        err.output = this.output;
        err.killed = true;
        err.timeoutKind = kind;
        reject(err);
      };

      const clearMaxTimer = () => {
        if (maxTimer) {
          clearTimeout(maxTimer);
          maxTimer = null;
        }
      };

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const resetIdleTimer = () => {
        clearIdleTimer();
        if (this.idleTimeout > 0) {
          idleTimer = setTimeout(() => {
            failWithTimeout('idle', this.idleTimeout);
          }, this.idleTimeout);
        }
      };

      if (this.timeout > 0) {
        maxTimer = setTimeout(() => {
          failWithTimeout('max runtime', this.timeout);
        }, this.timeout);
      }
      resetIdleTimer();

      const clearTimers = () => {
        clearMaxTimer();
        clearIdleTimer();
      };

      // -- Stream handling -------------------------------------------------
      if (this.process.stdout) {
        this.process.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          this.output += text;
          resetIdleTimer();
          if (onData) onData('stdout', text);
        });
      }

      if (this.process.stderr) {
        this.process.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          this.output += text;
          resetIdleTimer();
          if (onData) onData('stderr', text);
        });
      }

      // -- Exit / error handling -------------------------------------------
      this.process.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        err.output = this.output;
        reject(err);
      });

      this.process.on('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve({
          exitCode,
          output: this.output,
          killed: this.killed,
        });
      });
    });
  }

  /**
   * Kill the running process.
   *
   * On Windows we use `taskkill` to tear down the entire process tree.
   * On Unix we send SIGTERM.
   */
  kill() {
    if (!this.process || !this.process.pid) return;

    this.killed = true;
    const isWindows = os.platform() === 'win32';

    if (isWindows) {
      // Force-kill the entire process tree on Windows
      exec(`taskkill /pid ${this.process.pid} /f /t`, () => {
        // Errors here are non-critical (process may have already exited)
      });
    } else {
      this.process.kill('SIGTERM');
    }
  }

  /**
   * Write text to the process's stdin stream.
   *
   * @param {string} text - Text to send.
   */
  sendInput(text) {
    if (
      this.process &&
      this.process.stdin &&
      !this.process.stdin.destroyed
    ) {
      this.process.stdin.write(text);
      return true;
    }
    return false;
  }

  /** Close the process's stdin stream when no more input should be sent. */
  endInput() {
    if (
      this.process &&
      this.process.stdin &&
      !this.process.stdin.destroyed
    ) {
      this.process.stdin.end();
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { ProcessRunner };
