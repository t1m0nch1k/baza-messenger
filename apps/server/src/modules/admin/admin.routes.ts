import { Router } from 'express';
import { getDb } from '../../db/sqlite';
import { requireAuth, requireRole } from '../../middleware/authz';

const router = Router();

router.get('/stats', requireAuth, requireRole('admin'), async (_req, res) => {
  const db = await getDb();
  const totalUsers = (await db.get<{ c: number }>('SELECT COUNT(*) c FROM users'))?.c || 0;
  const bannedUsers = (await db.get<{ c: number }>('SELECT COUNT(*) c FROM users WHERE isBanned=1'))?.c || 0;
  const premiumUsers = (await db.get<{ c: number }>('SELECT COUNT(*) c FROM users WHERE isPremium=1'))?.c || 0;

  res.json({
    totalUsers,
    bannedUsers,
    premiumUsers,
  });
});

export { router as adminRoutes };

