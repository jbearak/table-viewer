// The host's one content digest: lowercase hex SHA-256 of a file's bytes.
//
// Save verification, refresh, the snapshot's Structural Basis (see
// `structural-editing-capability.ts`), and the structural save's basis checks
// and prefix-growth test all compare digests made here, so a basis the
// webview records at delete time is byte-for-byte the one Save checks.
import { createHash } from 'node:crypto';

export function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}
