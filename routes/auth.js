'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

/**
 * POST /api/auth/check — проверить телефон
 */
router.post('/check', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Требуется phone' });
    
    const user = await global.db.get('SELECT phone FROM users WHERE phone=?', [phone]);
    res.json({ exists: !!user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/auth/verify — проверить код
 */
router.post('/verify', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const user = await global.db.get('SELECT verificationCode,isVerified FROM users WHERE phone=?', [phone]);
    
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.isVerified) return res.json({ verified: true });
    if (user.verificationCode !== String(code).trim()) {
      return res.status(400).json({ error: 'Неверный код' });
    }
    
    await global.db.run('UPDATE users SET isVerified=1, verificationCode=NULL WHERE phone=?', [phone]);
    res.json({ verified: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;