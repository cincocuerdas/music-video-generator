import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';
import { parsePositiveIntEnv } from '../utils/env-parsers';
import { toStructuredLog } from '../utils/structured-log.util';

export interface ProgressEvent {
  type: 'image_generated' | 'job_update' | 'progress';
  data: any;
}

export function extractProgressPayload(line: string): string | null {
  if (!line) {
    return null;
  }
  const stripped = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const jsonMarkerIndex = stripped.indexOf('PROGRESS_JSON:');
  if (jsonMarkerIndex !== -1) {
    return stripped.substring(jsonMarkerIndex + 'PROGRESS_JSON:'.length).trim();
  }
  const markerIndex = stripped.indexOf('PROGRESS:');
  if (markerIndex === -1) {
    return null;
  }
  return stripped.substring(markerIndex + 'PROGRESS:'.length).trim();
}

export function extractResultPayload(line: string): string | null {
  if (!line) {
    return null;
  }
  const stripped = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const markerIndex = stripped.indexOf('RESULT_JSON:');
  if (markerIndex === -1) {
    return null;
  }
  return stripped.substring(markerIndex + 'RESULT_JSON:'.length).trim();
}

class BoundedTextBuffer {
  private buffer = '';
  private truncatedChars = 0;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text) {
      return;
    }
    this.buffer += text;
    if (this.buffer.length > this.maxChars) {
      const overflow = this.buffer.length - this.maxChars;
      this.buffer = this.buffer.slice(overflow);
      this.truncatedChars += overflow;
    }
  }

  trim(): string {
    return this.buffer.trim();
  }

  raw(): string {
    return this.buffer;
  }

  withNotice(): string {
    if (this.truncatedChars <= 0) {
      return this.buffer;
    }
    return `[truncated ${this.truncatedChars} chars]\n${this.buffer}`;
  }
}

@Injectable()
export class PythonRunnerService {
  private readonly logger = new Logger(PythonRunnerService.name);
  private pythonPath: string;
  private readonly defaultTimeoutMs = 30 * 60 * 1000; // 30 min
  private readonly stdoutBufferMaxChars: number;
  private readonly stderrBufferMaxChars: number;

  constructor(private configService: ConfigService) {
    this.pythonPath = this.configService.get<string>('PYTHON_PATH') || 'python';
    this.stdoutBufferMaxChars = parsePositiveIntEnv(
      'PYTHON_RUNNER_STDOUT_BUFFER_MAX_CHARS',
      1_000_000,
    );
    this.stderrBufferMaxChars = parsePositiveIntEnv(
      'PYTHON_RUNNER_STDERR_BUFFER_MAX_CHARS',
      1_000_000,
    );
  }

  private resolveScriptTimeoutMs(scriptName: string): number {
    const envOverride = this.configService.get<string>('PYTHON_SCRIPT_TIMEOUT_MS');
    if (envOverride) {
      const parsed = Number(envOverride);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    const byScript: Record<string, number> = {
      'youtube_download.py': 10 * 60 * 1000,
      'transcribe_audio.py': 25 * 60 * 1000,
      'analyze_lyrics.py': 10 * 60 * 1000,
      'generate_images.py': 2 * 60 * 60 * 1000,
      'render_video.py': 40 * 60 * 1000,
      'train_style_lora.py': 8 * 60 * 60 * 1000,
      'auto_generate_video.py': 3 * 60 * 60 * 1000,
    };

    return byScript[scriptName] ?? this.defaultTimeoutMs;
  }

  async runScript<T = unknown>(scriptName: string, args: string[]): Promise<T> {
    return this.runScriptWithProgress<T>(scriptName, args);
  }

  async runScriptWithProgress<T = unknown>(
    scriptName: string,
    args: string[],
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(process.cwd(), 'scripts', scriptName);
      const timeoutMs = this.resolveScriptTimeoutMs(scriptName);

      this.logger.log(
        toStructuredLog('python.run.start', {
          scriptName,
          scriptPath,
          args,
          timeoutMs,
          pythonPath: this.pythonPath,
        }),
      );

      const pythonProcess = spawn(this.pythonPath, [scriptPath, ...args]);
      let settled = false;

      const stdoutTail = new BoundedTextBuffer(this.stdoutBufferMaxChars);
      const stderrTail = new BoundedTextBuffer(this.stderrBufferMaxChars);
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let hasExplicitResult = false;
      let explicitResult: any = null;
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.logger.error(
          toStructuredLog('python.run.timeout', {
            scriptName,
            timeoutMs,
          }),
        );
        pythonProcess.kill('SIGKILL');
        reject(
          new Error(
            `Script timed out after ${Math.round(timeoutMs / 1000)}s: ${scriptName}`,
          ),
        );
      }, timeoutMs);

      const maybeEmitProgress = (line: string): boolean => {
        if (!onProgress) {
          return false;
        }

        const payload = extractProgressPayload(line);
        if (payload === null) {
          return false;
        }

        if (!payload) {
          onProgress({ type: 'progress', data: { message: 'Progress update' } });
          return true;
        }

        try {
          const parsed = JSON.parse(payload);
          if (
            parsed &&
            typeof parsed === 'object' &&
            typeof parsed.type === 'string' &&
            parsed.data !== undefined
          ) {
            onProgress(parsed as ProgressEvent);
          } else {
            onProgress({ type: 'progress', data: parsed });
          }
        } catch {
          onProgress({ type: 'progress', data: { message: payload } });
        }

        return true;
      };

      const maybeCaptureResult = (line: string): boolean => {
        const payload = extractResultPayload(line);
        if (payload === null) {
          return false;
        }

        if (!payload) {
          this.logger.warn(
            toStructuredLog('python.run.result_json.empty_payload', {
              scriptName,
            }),
          );
          return true;
        }

        try {
          explicitResult = JSON.parse(payload);
          hasExplicitResult = true;
          return true;
        } catch (error) {
          this.logger.warn(
            toStructuredLog('python.run.result_json.invalid_payload', {
              scriptName,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return false;
        }
      };

      const processBufferedLines = (
        chunk: Buffer,
        isStdErr: boolean,
      ) => {
        const chunkText = chunk.toString();
        const activeBuffer = (isStdErr ? stderrBuffer : stdoutBuffer) + chunkText;
        const lines = activeBuffer.split(/\r?\n/);
        let trailing = lines.pop() ?? '';

        const trailingLimit = isStdErr
          ? this.stderrBufferMaxChars
          : this.stdoutBufferMaxChars;
        if (trailing.length > trailingLimit) {
          const tailBuffer = isStdErr ? stderrTail : stdoutTail;
          tailBuffer.append(trailing.slice(0, trailing.length - trailingLimit));
          trailing = trailing.slice(trailing.length - trailingLimit);
        }

        if (isStdErr) {
          stderrBuffer = trailing;
        } else {
          stdoutBuffer = trailing;
        }

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          if (maybeEmitProgress(line)) {
            this.logger.debug(
              toStructuredLog('python.run.progress', {
                scriptName,
                line: line.trim(),
              }),
            );
            continue;
          }

          if (maybeCaptureResult(line)) {
            this.logger.debug(
              toStructuredLog('python.run.result_json.captured', {
                scriptName,
              }),
            );
            continue;
          }

          if (isStdErr) {
            stderrTail.append(`${line}\n`);
            this.logger.warn(
              toStructuredLog('python.run.stderr', {
                scriptName,
                line,
              }),
            );
          } else {
            stdoutTail.append(`${line}\n`);
            this.logger.debug(
              toStructuredLog('python.run.stdout', {
                scriptName,
                line,
              }),
            );
          }
        }
      };

      pythonProcess.stdout.on('data', (data) => {
        processBufferedLines(data, false);
      });

      pythonProcess.stderr.on('data', (data) => {
        processBufferedLines(data, true);
      });

      pythonProcess.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);

        if (stdoutBuffer.trim()) {
          if (!maybeEmitProgress(stdoutBuffer) && !maybeCaptureResult(stdoutBuffer)) {
            stdoutTail.append(`${stdoutBuffer}\n`);
            this.logger.debug(
              toStructuredLog('python.run.stdout.trailing', {
                scriptName,
                line: stdoutBuffer,
              }),
            );
          }
        }
        if (stderrBuffer.trim()) {
          if (!maybeEmitProgress(stderrBuffer) && !maybeCaptureResult(stderrBuffer)) {
            stderrTail.append(`${stderrBuffer}\n`);
            this.logger.warn(
              toStructuredLog('python.run.stderr.trailing', {
                scriptName,
                line: stderrBuffer,
              }),
            );
          }
        }

        if (code !== 0) {
          this.logger.error(
            toStructuredLog('python.run.failed', {
              scriptName,
              code,
              error: stderrTail.withNotice() || 'Unknown error',
            }),
          );
          reject(new Error(`Script failed: ${stderrTail.withNotice() || 'Unknown error'}`));
          return;
        }

        try {
          if (hasExplicitResult) {
            resolve(explicitResult);
            return;
          }

          if (!stdoutTail.trim()) {
            resolve({ message: 'Script finished without output' } as T);
            return;
          }

          const rawStdout = stdoutTail.raw();
          const jsonStartIndex = rawStdout.indexOf('{');
          const jsonEndIndex = rawStdout.lastIndexOf('}');

          if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
            const jsonPart = rawStdout.substring(jsonStartIndex, jsonEndIndex + 1);
            const result = JSON.parse(jsonPart);
            resolve(result);
          } else {
            resolve({ rawOutput: stdoutTail.withNotice() } as T);
          }

        } catch (error) {
          this.logger.warn(
            toStructuredLog('python.run.stdout.non_json', {
              scriptName,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          resolve({ rawOutput: stdoutTail.withNotice() } as T);
        }
      });

      pythonProcess.on('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  }
}
