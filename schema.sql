CREATE TABLE IF NOT EXISTS player_saves (
	account_id TEXT PRIMARY KEY,
	steam_id TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 1,
	updated_at INTEGER NOT NULL,
	client_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_saves_steam_id ON player_saves (steam_id);
