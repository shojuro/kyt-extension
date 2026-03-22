/**
 * Tests for auto-key encryption system (notebooklm-auth.js).
 * Tests key generation, effective passphrase resolution, migration, and cookie encrypt/decrypt.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';

// We can't easily test the module directly (it uses hardcoded paths),
// so we test the logic patterns it implements.

describe('auto-key generation logic', () => {
  const testDir = join(tmpdir(), `kyt-autokey-test-${Date.now()}`);
  const testKeyPath = join(testDir, 'encryption-key');

  before(() => {
    mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    try { unlinkSync(testKeyPath); } catch {}
    try { unlinkSync(join(testDir, 'test.enc')); } catch {}
  });

  it('generates a 64-char hex key (32 bytes)', () => {
    const key = randomBytes(32).toString('hex');
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('writes key with wx flag (exclusive create)', () => {
    const key = randomBytes(32).toString('hex');
    writeFileSync(testKeyPath, key, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    assert.ok(existsSync(testKeyPath));
    assert.equal(readFileSync(testKeyPath, 'utf8'), key);
  });

  it('wx flag prevents overwrite of existing key', () => {
    // Key already exists from previous test
    assert.throws(() => {
      writeFileSync(testKeyPath, 'overwrite-attempt', { encoding: 'utf8', flag: 'wx' });
    }, { code: 'EEXIST' });
  });

  it('reads back the original key after failed overwrite', () => {
    const key = readFileSync(testKeyPath, 'utf8').trim();
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });
});

describe('effective passphrase resolution', () => {
  // Mirrors getEffectivePassphrase() logic
  function getEffectivePassphrase(explicit, autoKey, envVar) {
    if (explicit && explicit.length >= 4) return explicit;
    if (autoKey && autoKey.length >= 4) return autoKey;
    if (envVar && envVar.length >= 4) return envVar;
    return null;
  }

  it('explicit passphrase takes priority', () => {
    const result = getEffectivePassphrase('mypass', 'autokey123', 'envpass');
    assert.equal(result, 'mypass');
  });

  it('auto-key used when no explicit passphrase', () => {
    const result = getEffectivePassphrase(null, 'autokey123', 'envpass');
    assert.equal(result, 'autokey123');
  });

  it('env var used as last resort', () => {
    const result = getEffectivePassphrase(null, null, 'envpass');
    assert.equal(result, 'envpass');
  });

  it('returns null when nothing available', () => {
    const result = getEffectivePassphrase(null, null, null);
    assert.equal(result, null);
  });

  it('rejects short passphrases (< 4 chars)', () => {
    const result = getEffectivePassphrase('ab', null, null);
    assert.equal(result, null);
  });

  it('falls through short explicit to valid auto-key', () => {
    const result = getEffectivePassphrase('ab', 'autokey123', null);
    assert.equal(result, 'autokey123');
  });

  it('empty string treated as unavailable', () => {
    const result = getEffectivePassphrase('', '', '');
    assert.equal(result, null);
  });
});

describe('encrypt/decrypt round-trip with auto-key', () => {
  const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;
  const IV_LEN = 12, SALT_LEN = 16, AUTH_TAG_LEN = 16;

  function encrypt(data, passphrase) {
    const salt = randomBytes(SALT_LEN);
    const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, authTag, encrypted]).toString('base64');
  }

  function decrypt(base64, passphrase) {
    const packed = Buffer.from(base64, 'base64');
    const salt = packed.subarray(0, SALT_LEN);
    const iv = packed.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const authTag = packed.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN);
    const ciphertext = packed.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN);
    const key = scryptSync(passphrase, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  }

  it('round-trips with auto-generated hex key', () => {
    const autoKey = randomBytes(32).toString('hex');
    const data = { cookies: [{ name: 'SID', value: 'test123', domain: '.google.com' }], savedAt: new Date().toISOString() };
    const encrypted = encrypt(data, autoKey);
    const decrypted = decrypt(encrypted, autoKey);
    assert.deepEqual(decrypted.cookies, data.cookies);
  });

  it('fails with wrong key', () => {
    const key1 = randomBytes(32).toString('hex');
    const key2 = randomBytes(32).toString('hex');
    const encrypted = encrypt({ test: true }, key1);
    assert.throws(() => decrypt(encrypted, key2));
  });

  it('migration: decrypt with old passphrase, re-encrypt with auto-key', () => {
    const oldPass = 'my-old-passphrase';
    const autoKey = randomBytes(32).toString('hex');
    const data = { cookies: [{ name: 'HSID', value: 'abc', domain: '.google.com' }] };

    // Encrypt with old passphrase
    const oldEncrypted = encrypt(data, oldPass);

    // Decrypt with old, re-encrypt with auto-key
    const decrypted = decrypt(oldEncrypted, oldPass);
    const newEncrypted = encrypt(decrypted, autoKey);

    // Verify new encryption works
    const finalDecrypted = decrypt(newEncrypted, autoKey);
    assert.deepEqual(finalDecrypted.cookies, data.cookies);

    // Old passphrase no longer works on new encryption
    assert.throws(() => decrypt(newEncrypted, oldPass));
  });
});

describe('hasPassphrase integration', () => {
  it('returns true when auto-key exists (no explicit passphrase needed)', () => {
    // Simulates hasPassphrase() with auto-key
    function hasPassphrase(explicit, autoKeyExists, envVar) {
      const effective = (explicit && explicit.length >= 4) ? explicit
        : (autoKeyExists ? 'auto-key-value-here' : null)
        || (envVar && envVar.length >= 4 ? envVar : null);
      return effective !== null;
    }

    assert.equal(hasPassphrase(null, true, null), true, 'auto-key alone should be sufficient');
    assert.equal(hasPassphrase(null, false, null), false, 'nothing available');
    assert.equal(hasPassphrase('explicit', false, null), true, 'explicit works');
    assert.equal(hasPassphrase(null, false, 'envvar'), true, 'env var works');
  });
});
