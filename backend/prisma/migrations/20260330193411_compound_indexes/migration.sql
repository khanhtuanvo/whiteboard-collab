-- DropIndex
DROP INDEX `elements_z_index_idx` ON `elements`;

-- CreateIndex
CREATE INDEX `boards_owner_id_updated_at_idx` ON `boards`(`owner_id`, `updated_at`);

-- CreateIndex
CREATE INDEX `elements_board_id_z_index_idx` ON `elements`(`board_id`, `z_index`);

-- CreateIndex
CREATE INDEX `snapshots_board_id_created_at_idx` ON `snapshots`(`board_id`, `created_at`);
