/**
 * 📦 MessageEncryptor — шифрование сообщений
 */

class MessageEncryptor {
  constructor(keyManager) {
    this.keyManager = keyManager;
    this.sessionKeys = new Map();
  }

  async deriveSharedSecret(peerPublicKeyBase64Url) {
    const theirPublicKeyRaw = this.keyManager._base64UrlToArrayBuffer(peerPublicKeyBase64Url);
    const theirPublicKey = await window.crypto.subtle.importKey(
      'raw',
      theirPublicKeyRaw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPublicKey },
      this.keyManager.keys.keyPair.privateKey,
      256
    );

    const baseKey = await window.crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey']);

    return window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('baza-v2-salt'),
        info: new TextEncoder().encode('aes-gcm-encryption-key')
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encryptMessage(plaintext, aesKey) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      encoded
    );
    
    return {
      ciphertext: this.keyManager._arrayBufferToBase64Url(ciphertext),
      iv: this.keyManager._arrayBufferToBase64Url(iv),
      algorithm: 'AES-256-GCM',
    };
  }

  async decryptMessage({ ciphertext, iv, algorithm }, aesKey) {
    const ciphertextBuffer = this.keyManager._base64UrlToArrayBuffer(ciphertext);
    const ivBuffer = this.keyManager._base64UrlToArrayBuffer(iv);
    
    const decrypted = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuffer },
      aesKey,
      ciphertextBuffer
    );
    
    return new TextDecoder().decode(decrypted);
  }
}

export default MessageEncryptor;