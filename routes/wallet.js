'use strict';
const express = require('express');
const argon2 = require('argon2');
const router = express.Router();

/**
 * POST /api/wallet/pin — установить PIN
 */
router.post('/pin', async (req, res) => {
  try {
    const { userId, pin, salt } = req.body;
    if (!userId || !pin || !salt) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }
    
    const pinHash = await argon2.hash(String(pin), {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 2,
    });
    
    await global.db.run(
      'UPDATE users SET walletPinHash=?, walletSalt=? WHERE phone=?',
      [pinHash, salt, userId]
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/wallet/pin/verify — проверить PIN
 */
router.post('/pin/verify', async (req, res) => {
  try {
    const { userId, pin } = req.body;
    const user = await global.db.get('SELECT walletPinHash FROM users WHERE phone=?', [userId]);
    
    if (!user?.walletPinHash) {
      return res.json({ verified: true });
    }
    
    const verified = await argon2.verify(user.walletPinHash, String(pin));
    res.json({ verified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;