const express = require('express');
const db = require('../db');
const { getBatchHeader, num, str } = require('../lib/batchHelpers');
const { advanceStage, nextStagePath } = require('../lib/stages');
const { requirePermission } = require('../lib/auth');
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
    today: new Date().toISOString().slice(0, 10),
  });
});

router.post('/batches/:id/dispatch', requirePermission('edit_dispatch'), (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const b = req.body;
  const qty = num(b.qty_kg);
  if (!qty) return res.redirect(`/batches/${batch.id}/dispatch`);

  const external = b.destination_type === 'external';
  db.prepare(
    `INSERT INTO compost_dispatches
       (compost_batch_id, dispatch_date, qty_kg, destination_type, buyer_name, spec_snapshot, cost_share_npr, entered_by, notes)
     VALUES (@compost_batch_id, @dispatch_date, @qty_kg, @destination_type, @buyer_name, @spec_snapshot, @cost_share_npr, @entered_by, @notes)`
  ).run({
    compost_batch_id: batch.id,
    dispatch_date: str(b.dispatch_date) || new Date().toISOString().slice(0, 10),
    qty_kg: qty,
    destination_type: external ? 'external' : 'internal',
    buyer_name: external ? str(b.buyer_name) : null,
    spec_snapshot: JSON.stringify(buildSpecSnapshot(batch.id)),
    cost_share_npr: costShareFor(batch.id, qty),
    entered_by: str(b.entered_by),
    notes: str(b.notes),
  });

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
    today: new Date().toISOString().slice(0, 10),
  });
});

router.post('/batches/:id/receipt', requirePermission('edit_receipt'), (req, res) => {
  const batch = getBatchHeader(req.params.id, req.farmId);
  if (!batch) return res.status(404).render('404');
  const b = req.body;

  // Claim an unclaimed internal dispatch for this growing batch. Guarded on
  // growing_batch_id still being null so two growing batches can't both claim
  // the same delivery.
  const claimed = db
    .prepare(
      `UPDATE compost_dispatches
         SET growing_batch_id = ?, receipt_date = ?, received_qty_kg = ?
       WHERE id = ? AND destination_type = 'internal' AND growing_batch_id IS NULL`
    )
    .run(
      batch.id,
      str(b.receipt_date) || new Date().toISOString().slice(0, 10),
      num(b.received_qty_kg),
      num(b.dispatch_id)
    );

  if (claimed.changes && b.advance) {
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
