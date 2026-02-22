import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as path from 'path';

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

@Injectable()
export class PythonRunnerService {
  private readonly logger = new Logger(PythonRunnerService.name);
  private pythonPath: string;
  private readonly defaultTimeoutMs = 30 * 60 * 1000; // 30 min

  constructor(private configService: ConfigService) {
    this.pythonPath = this.configService.get<string>('PYTHON_PATH') || 'python';
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

  async runScript(scriptName: string, args: string[]): Promise<any> {
    return this.runScriptWithProgress(scriptName, args);
  }

  async runScriptWithProgress(
    scriptName: string,
    args: string[],
    onProgress?: (event: ProgressEvent) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(process.cwd(), 'scripts', scriptName);
      const timeoutMs = this.resolveScriptTimeoutMs(scriptName);

      this.logger.log(`Ejecutando Python: ${this.pythonPath} ${scriptPath} ${args.join(' ')}`);

      const pythonProcess = spawn(this.pythonPath, [scriptPath, ...args]);
      let settled = false;

      let dataString = '';
      let errorString = '';
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
          `Python script timed out after ${timeoutMs}ms: ${scriptName}`,
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
          this.logger.warn('Received RESULT_JSON marker without payload');
          return true;
        }

        try {
          explicitResult = JSON.parse(payload);
          hasExplicitResult = true;
          return true;
        } catch (error) {
          this.logger.warn(
            `Could not parse RESULT_JSON payload: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      };

      const processBufferedLines = (
        chunk: Buffer,
        isStdErr: boolean,
      ) => {
        const chunkText = chunk.toString();
        if (isStdErr) {
          stderrBuffer += chunkText;
        } else {
          stdoutBuffer += chunkText;
        }

        const activeBuffer = isStdErr ? stderrBuffer : stdoutBuffer;
        const lines = activeBuffer.split(/\r?\n/);
        const trailing = lines.pop() ?? '';

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
            this.logger.debug(`[Python progress]: ${line.trim()}`);
            continue;
          }

          if (maybeCaptureResult(line)) {
            this.logger.debug('[Python result payload captured]');
            continue;
          }

          if (isStdErr) {
            errorString += `${line}\n`;
            this.logger.warn(`[Python stderr]: ${line}`);
          } else {
            dataString += `${line}\n`;
            this.logger.debug(`[Python stdout]: ${line}`);
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
            dataString += `${stdoutBuffer}\n`;
            this.logger.debug(`[Python stdout]: ${stdoutBuffer}`);
          }
        }
        if (stderrBuffer.trim()) {
          if (!maybeEmitProgress(stderrBuffer) && !maybeCaptureResult(stderrBuffer)) {
            errorString += `${stderrBuffer}\n`;
            this.logger.warn(`[Python stderr]: ${stderrBuffer}`);
          }
        }

        if (code !== 0) {
          this.logger.error(`Python script failed with code ${code}`);
          reject(new Error(`Script failed: ${errorString || 'Unknown error'}`));
          return;
        }

        try {
          if (hasExplicitResult) {
            resolve(explicitResult);
            return;
          }

          if (!dataString.trim()) {
            resolve({ message: 'Script finished without output' });
            return;
          }

          const jsonStartIndex = dataString.indexOf('{');
          const jsonEndIndex = dataString.lastIndexOf('}');

          if (jsonStartIndex !== -1 && jsonEndIndex !== -1) {
            const jsonPart = dataString.substring(jsonStartIndex, jsonEndIndex + 1);
            const result = JSON.parse(jsonPart);
            resolve(result);
          } else {
            resolve({ rawOutput: dataString });
          }

        } catch (error) {
          this.logger.warn('Could not parse Python output as JSON');
          resolve({ rawOutput: dataString });
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
