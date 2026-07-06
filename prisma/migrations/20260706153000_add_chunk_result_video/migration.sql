ALTER TABLE novel_promotion_projects
  ADD COLUMN chunkResultVideoMediaId VARCHAR(191) NULL;

CREATE INDEX novel_promotion_projects_chunkResultVideoMediaId_idx
  ON novel_promotion_projects (chunkResultVideoMediaId);

ALTER TABLE novel_promotion_projects
  ADD CONSTRAINT novel_promotion_projects_chunkResultVideoMediaId_fkey
  FOREIGN KEY (chunkResultVideoMediaId) REFERENCES media_objects(id)
  ON DELETE SET NULL ON UPDATE CASCADE;
