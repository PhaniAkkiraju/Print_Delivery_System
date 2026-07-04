'use strict';

/**
 * PrintIt — Firebase Cloud Functions (2nd gen)
 *
 * completeDeliveredOrders
 * ───────────────────────
 * Runs every minute via Cloud Scheduler.
 * Finds every order where:
 *   - status == 'active'
 *   - (placedAt + deliSec * 1000) <= Date.now()
 *
 * Updates those orders to { status: 'delivered', deliveredAt: <now> }
 * using the Admin SDK — which bypasses all Firestore security rules —
 * then appends a success log entry to the `logs` collection.
 *
 * This is the single authoritative source of order completion.
 * The client-side countdown in app.js only drives local UI animations;
 * the real Firestore flip comes from here and propagates back to all
 * connected clients via their existing onSnapshot listeners.
 */

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger }     = require('firebase-functions');
const admin          = require('firebase-admin');

// ── Initialise Admin SDK (once) ────────────────────────────────────────────
admin.initializeApp();
const db = admin.firestore();

// ── Scheduled function: every 1 minute ────────────────────────────────────
exports.completeDeliveredOrders = onSchedule(
  {
    schedule:        'every 1 minutes',
    timeZone:        'Asia/Kolkata',   // IST — adjust if needed
    retryCount:      3,                // retry up to 3 times on failure
    memory:          '256MiB',
    timeoutSeconds:  60,
  },
  async (_event) => {
    const now = Date.now();

    // ── 1. Fetch all active orders ─────────────────────────────────────────
    let snap;
    try {
      snap = await db
        .collection('orders')
        .where('status', '==', 'active')
        .get();
    } catch (err) {
      logger.error('completeDeliveredOrders: failed to query orders', err);
      return;
    }

    if (snap.empty) {
      logger.info('completeDeliveredOrders: no active orders found');
      return;
    }

    // ── 2. Filter to orders whose delivery window has elapsed ──────────────
    const expired = snap.docs.filter((doc) => {
      const { placedAt, deliSec } = doc.data();
      // placedAt is stored as a JS timestamp (ms). deliSec is seconds.
      return (
        typeof placedAt === 'number' &&
        typeof deliSec  === 'number' &&
        placedAt + deliSec * 1000 <= now
      );
    });

    if (expired.length === 0) {
      logger.info('completeDeliveredOrders: no orders past their delivery time yet');
      return;
    }

    logger.info(`completeDeliveredOrders: completing ${expired.length} order(s)`);

    // ── 3. Batch-update expired orders + write log entries ─────────────────
    // Firestore batches are capped at 500 ops; split if needed.
    const BATCH_LIMIT = 249; // 2 ops per order (update + log) → 498 ≤ 500
    const chunks      = [];
    for (let i = 0; i < expired.length; i += BATCH_LIMIT) {
      chunks.push(expired.slice(i, i + BATCH_LIMIT));
    }

    for (const chunk of chunks) {
      const batch = db.batch();

      for (const doc of chunk) {
        const orderId    = doc.id;
        const orderData  = doc.data();
        const deliveredAt = now;

        // Update the order document
        batch.update(doc.ref, {
          status:      'delivered',
          deliveredAt: deliveredAt,
        });

        // Append a log entry matching the existing format: { text, type, time }
        const logRef = db.collection('logs').doc(); // auto-ID
        batch.set(logRef, {
          text: `Order ${orderId} delivered to ${orderData.username || 'customer'} (${orderData.address || ''})`,
          type: 'success',
          time: deliveredAt,
        });

        logger.info(`  → Completing order ${orderId} for ${orderData.username || '(unknown)'}`);
      }

      try {
        await batch.commit();
      } catch (err) {
        logger.error('completeDeliveredOrders: batch commit failed', err);
        // Continue to next chunk rather than aborting everything
      }
    }

    logger.info('completeDeliveredOrders: done');
  }
);
