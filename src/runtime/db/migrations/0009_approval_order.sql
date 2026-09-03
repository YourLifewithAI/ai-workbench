-- RUN-12: the order a step asked in. ULIDs are only monotonic within a millisecond when a monotonic factory
-- makes them, and two parallel tool calls land in the same millisecond — so the card's order was luck.
ALTER TABLE approvals ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
