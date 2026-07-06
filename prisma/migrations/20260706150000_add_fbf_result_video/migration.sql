ALTER TABLE novel_promotion_projects
  ADD COLUMN fbfResultVideoMediaId VARCHAR(191) NULL;

CREATE INDEX novel_promotion_projects_fbfResultVideoMediaId_idx
  ON novel_promotion_projects (fbfResultVideoMediaId);

ALTER TABLE novel_promotion_projects
  ADD CONSTRAINT novel_promotion_projects_fbfResultVideoMediaId_fkey
  FOREIGN KEY (fbfResultVideoMediaId) REFERENCES media_objects(id)
  ON DELETE SET NULL ON UPDATE CASCADE;
