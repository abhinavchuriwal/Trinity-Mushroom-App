// The fixed permission catalog: every capability a role can be granted. Kept
// as its own dependency-free module (no `require('../db')`) so both db.js's
// one-time role seed and lib/auth.js's route guards can use it without a
// circular require between the two.
const PERMISSIONS = [
  { key: 'edit_prewetting', label: 'Edit Pre-Wetting', group: 'Compost Department' },
  { key: 'edit_phase1', label: 'Edit Phase I Composting', group: 'Compost Department' },
  { key: 'edit_phase2', label: 'Edit Phase II', group: 'Compost Department' },
  { key: 'edit_spawning', label: 'Edit Spawning', group: 'Compost Department' },
  { key: 'edit_casing', label: 'Edit Casing', group: 'Growing Department' },
  { key: 'edit_room_in', label: 'Edit Room In', group: 'Growing Department' },
  { key: 'edit_harvest', label: 'Edit Harvest (incl. Log Harvest)', group: 'Growing Department' },
  { key: 'edit_room_out', label: 'Edit Room Out', group: 'Growing Department' },
  { key: 'delete_batch', label: 'Delete a batch', group: 'Admin' },
  { key: 'reset_training_data', label: 'Wipe all data in a Training farm', group: 'Admin' },
  { key: 'manage_backups', label: 'Create and download database backups', group: 'Admin' },
  { key: 'manage_qc_settings', label: 'Manage QC Settings', group: 'Admin' },
  { key: 'manage_farm_master', label: 'Manage Farm Master Data (rooms/tunnels/bunkers)', group: 'Admin' },
  { key: 'manage_raw_materials', label: 'Manage Raw Materials', group: 'Admin' },
  { key: 'manage_users_roles', label: 'Manage Users & Roles', group: 'Admin' },
  { key: 'export_data', label: 'Download / export data (CSV)', group: 'Admin' },
  { key: 'use_ai_knowledge', label: 'Use the AI Knowledge tab', group: 'Informational' },
];

module.exports = { PERMISSIONS };
