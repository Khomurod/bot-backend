const crypto = require('crypto');
const config = require('../config/config');

function getKey() {
  return crypto
    .createHash('sha256')
    .update(String(config.facebookTokenEncryptionKey || config.jwtSecret || ''))
    .digest();
}

function encryptText(plainText) {
  const value = String(plainText || '');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptText(payload) {
  if (!payload) return '';
  const [ivPart, tagPart, encryptedPart] = String(payload).split('.');
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error('Encrypted payload is malformed');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(ivPart, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = {
  encryptText,
  decryptText,
};
