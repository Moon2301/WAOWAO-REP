ALTER TABLE novel_promotion_projects
  ADD COLUMN videoEditFbfSession TEXT NULL,
  ADD COLUMN videoEditChunkSession TEXT NULL;

CREATE TABLE video_edit_renders (
  id VARCHAR(191) NOT NULL,
  projectId VARCHAR(191) NOT NULL,
  engine VARCHAR(16) NOT NULL,
  videoMediaId VARCHAR(191) NOT NULL,
  meta TEXT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX video_edit_renders_projectId_engine_createdAt_idx (projectId, engine, createdAt),
  CONSTRAINT video_edit_renders_projectId_fkey
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT video_edit_renders_videoMediaId_fkey
    FOREIGN KEY (videoMediaId) REFERENCES media_objects(id) ON DELETE CASCADE ON UPDATE CASCADE
);
