/**
 * 🗝️ KeyManager — управление ключами (клиент)
 */

const DB_NAME = 'baza-e2ee';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

class KeyManager {
  constructor(userId) {
    this.userId = userId;
    this.db = null;
    this.keys = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'userId' });
        }
      };
      
      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve();
      };
      
      request.onerror = (e) => reject(e.target.error);
    });
  }

  async generateKeyPair() {
    const keyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );

    const publicKeyRaw = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
    
    return {
      publicKey: this._arrayBufferToBase64Url(publicKeyRaw),
      keyPair: {
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
      }
    };
  }

  async saveKeys({ publicKey, metadata = {} }) {
    const tx = this.db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    await store.put({
      userId: this.userId,
      publicKey,
      createdAt: new Date().toISOString(),
      ...metadata
    });
    
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  _arrayBufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _base64UrlToArrayBuffer(base64Url) {
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    if (pad) base64 += '='.repeat(4 - pad);
    
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

export default KeyManager;