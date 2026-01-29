/**
 * macOS Keychain credential access.
 * Mirrors the pattern from apolitical-assistant.
 */

import { execSync } from 'node:child_process';

const KEYCHAIN_ACCOUNT = 'claude';

export function getKeychainCredential(name: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -a "${KEYCHAIN_ACCOUNT}" -s "${name}" -w 2>/dev/null`,
      { encoding: 'utf8' }
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get a credential from keychain, falling back to environment variable.
 */
export function getCredential(name: string): string | null {
  // Try keychain first
  const keychainValue = getKeychainCredential(name);
  if (keychainValue) {
    return keychainValue;
  }

  // Fall back to environment variable
  return process.env[name] ?? null;
}

/**
 * Get a required credential, throwing if not found.
 */
export function requireCredential(name: string): string {
  const value = getCredential(name);
  if (!value) {
    throw new Error(
      `Missing required credential: ${name}. ` +
        `Set it in macOS keychain (account: "${KEYCHAIN_ACCOUNT}") or as an environment variable.`
    );
  }
  return value;
}
