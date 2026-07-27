/**
 * Credential resolution.
 *
 * Secrets are read from the environment by name at call time and are never
 * persisted, logged, serialised into a propagation record, or sent to the
 * status UI. `MissingCredentialError` is deliberately specific enough to fix
 * the configuration without ever revealing a value.
 */

export class MissingCredentialError extends Error {
  readonly envVar: string;
  constructor(envVar: string) {
    super(`No credential found in environment variable ${envVar}.`);
    this.name = 'MissingCredentialError';
    this.envVar = envVar;
  }
}

export function resolveCredential(envVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[envVar];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MissingCredentialError(envVar);
  }
  return value;
}

/** True when a credential is present, without reading its value into scope. */
export function hasCredential(envVar: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[envVar];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Removes any occurrence of known secret values from text bound for a log or a
 * persisted reason string. Defence in depth: adapters already avoid echoing
 * credentials, this ensures a platform that reflects one back cannot leak it.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let output = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key)) continue;
    if (output.includes(value)) {
      output = output.split(value).join(`[redacted:${key}]`);
    }
  }
  return output;
}
