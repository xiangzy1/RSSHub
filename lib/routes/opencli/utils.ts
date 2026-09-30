import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Override the opencli binary path when the RSSHub process PATH does not
// include the nvm global bin (e.g. when launched by systemd/pm2). Set
// OPENCLI_BIN=/absolute/path/to/opencli in that environment.
export const OPENCLI_BIN = process.env.OPENCLI_BIN || 'opencli';

const MAX_BUFFER = 10 * 1024 * 1024;

interface OpenCliEnvelope {
    ok?: boolean;
    data?: unknown;
    error?: {
        code?: string;
        message?: string;
        hint?: string;
    };
}

function envelopeError(envelope: OpenCliEnvelope): string {
    const message = envelope.error?.message || 'unknown error';
    const hint = envelope.error?.hint ? ` (${envelope.error.hint})` : '';
    return `${message}${hint}`;
}

/**
 * opencli 2.x prints a single JSON envelope: `{ok:true,data}` on success and
 * `{ok:false,error}` on failure. Unwrap `data` so routes keep working with the
 * plain row arrays they render. A bare array is still accepted so an older
 * (1.x) local install keeps working.
 */
function unwrapEnvelope(parsed: unknown, label: string): unknown {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new TypeError(`${label} returned ${typeof parsed}, expected an opencli JSON envelope`);
    }
    const envelope = parsed as OpenCliEnvelope;
    if (envelope.ok === true) {
        return envelope.data;
    }
    if (envelope.ok === false) {
        throw new Error(`${label} failed: ${envelopeError(envelope)}`);
    }
    throw new TypeError(`${label} returned an unexpected JSON payload`);
}

/**
 * Run a local opencli command and return its unwrapped `data` payload.
 *
 * opencli 2.x reports command failures on stdout as an `{ok:false}` envelope
 * with a nonzero exit status and leaves stderr empty, so the envelope is read
 * before falling back to execFile's generic "Command failed" message.
 */
export async function runOpenCli(command: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }): Promise<unknown> {
    const label = `opencli ${command.slice(0, 2).join(' ')}`;
    let stdout: string;
    try {
        const result = await execFileAsync(OPENCLI_BIN, command, {
            maxBuffer: MAX_BUFFER,
            timeout: options.timeout,
            ...(options.env && { env: options.env }),
        });
        stdout = result.stdout;
    } catch (error: unknown) {
        const failure = error as { stdout?: string; stderr?: string; message?: string };
        let detail = '';
        try {
            const parsed: unknown = JSON.parse(failure.stdout ?? '');
            if (parsed && typeof parsed === 'object' && (parsed as OpenCliEnvelope).ok === false) {
                detail = envelopeError(parsed as OpenCliEnvelope);
            }
        } catch {
            // Not an envelope (older opencli / crash output): use stderr below.
        }
        if (!detail) {
            detail = (failure.stderr || failure.message || String(error)).trim();
        }
        throw new Error(`${label} failed: ${detail || 'unknown error'}`, { cause: error });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw new Error(`${label} returned non-JSON output (first 200 chars): ${stdout.slice(0, 200)}`, { cause: error });
    }
    return unwrapEnvelope(parsed, label);
}
