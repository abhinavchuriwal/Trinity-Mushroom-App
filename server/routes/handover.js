const express = require('express');
const db = require('../db');
const { getBatchHeader, num, str } = require('../lib/batchHelpers');
const { advanceStage, nextStagePath } = require('../lib/stages');
const { requirePermission } = require('../lib/auth');
const { recordDispatch, recordReceipt } = require('../lib/stageSaves');
const { todayLocal } = require('../lib/dates');
const {
  buildSpecSnapshot,
  costShareFor,
  dispatchesForCompostBatch,
  receiptsForGrowingBatch,
  unclaimedDispatches,
  parseSpec,
} = require('../lib/handover');

const router = express.Router();

// ---- Dispatch: compost leaving the compost unit ----
router.get('/batches/:id/dispatch', (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');

  const dispatches = dispatchesForCompostBatch(batch.id).map((d) => ({ ...d, spec: parseSpec(d.spec_snapshot) }));
  const spawning = db.prepare('SELECT fill_weight_kg FROM spawning WHERE batch_id = ?').get(batch.id) || {};
  const dispatchedKg = dispatches.reduce((s, d) => s + (d.qty_kg || 0), 0);

  res.render('stages/dispatch', {
    batch,
    currentPage: 'dispatch',
    readOnly: !res.locals.can('edit_dispatch'),
    stageMeta: { label: 'Dispatch', dept: 'compost' },
    dispatches,
    producedKg: spawning.fill_weight_kg || null,
    dispatchedKg,
    // Preview of the spec sheet that will travel with the next delivery.
    spec: buildSpecSnapshot(batch.id),
    today: todayLocal(),
  });
});

router.post('/batches/:id/dispatch', requirePermission('edit_dispatch'), (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const b = req.body;
  if (!recordDispatch(batch.id, b)) return res.redirect(`/batches/${batch.id}/dispatch`);

  if (b.advance) return void (advanceStage(batch.id, 'dispatch'), res.redirect(`/batches/${batch.id}`));
  res.redirect(`/batches/${batch.id}/dispatch`);
});

router.post('/batches/:id/dispatch/:dispatchId/delete', requirePermission('edit_dispatch'), (req, res) => {
  // Only while still unclaimed — once the growing unit has received it, the
  // delivery is a shared record and deleting it would strip that batch of its
  // compost spec and cost basis without their knowing.
  db.prepare(
    'DELETE FROM compost_dispatches WHERE id = ? AND compost_batch_id = ? AND growing_batch_id IS NULL'
  ).run(req.params.dispatchId, req.params.id);
  res.redirect(`/batches/${req.params.id}/dispatch`);
});

// ---- Receipt: compost arriving at the growing unit ----
router.get('/batches/:id/receipt', (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');

  const receipts = receiptsForGrowingBatch(batch.id);
  res.render('stages/receipt', {
    batch,
    currentPage: 'receipt',
    readOnly: !res.locals.can('edit_receipt'),
    stageMeta: { label: 'Compost Receipt', dept: 'growing' },
    receipts,
    // Deliveries sent but not yet claimed by any growing batch. This is the one
    // sanctioned window between the two units: the growing side sees the
    // delivery and its spec sheet, never the compost unit's own records.
    // One delivery per growing batch for now, so nothing is offered once this
    // batch has taken one.
    unclaimed: receipts.length ? [] : unclaimedDispatches(),
    today: todayLocal(),
  });
});

router.post('/batches/:id/receipt', requirePermission('edit_receipt'), (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const b = req.body;

  const claimed = recordReceipt(batch.id, b);

  if (claimed && b.advance) {
    advanceStage(batch.id, 'receipt');
    return res.redirect(nextStagePath('receipt', batch.id));
  }
  res.redirect(`/batches/${batch.id}/receipt`);
});

router.post('/batches/:id/receipt/:dispatchId/unlink', requirePermission('edit_receipt'), (req, res) => {
  db.prepare(
    `UPDATE compost_dispatches SET growing_batch_id = NULL, receipt_date = NULL, received_qty_kg = NULL
     WHERE id = ? AND growing_batch_id = ?`
  ).run(req.params.dispatchId, req.params.id);
  res.redirect(`/batches/${req.params.id}/receipt`);
});

module.exports = router;
