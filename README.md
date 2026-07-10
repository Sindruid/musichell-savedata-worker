# MusicHell Save Data Worker

This Wrangler project lives at the repository root, outside Unity's `Assets` folder, so Unity does not import it and it will never be included in a Unity build.

## What it does

- Exposes authenticated cloud save sync for Steam-linked accounts
- `GET /api/savedata` — fetch the merged cloud save for the authenticated account
- `POST /api/savedata/sync` — merge a client snapshot into cloud storage and return the winner
- Validates the signed session token issued by `musichell-account-worker`
- Intended payload is progress-only: high scores and skin unlock / seen state
- Merge policy:
  - Skin unlock / seen lists: union (unlocked / seen on either side always sticks)
  - Level scores and sticky best-score flags: highest numeric value wins
  - Other keys (if present from older clients): newest `updatedAtUnixMs` wins

## Setup

1. Create a D1 database:
   `npx wrangler d1 create musichell-savedata-db`
2. Copy the returned database id into `wrangler.jsonc` for `SAVEDATA_DB`.
3. Apply the schema:
   `npx wrangler d1 execute musichell-savedata-db --remote --file=schema.sql`
4. Shared session signing uses Secrets Store binding `SESSION_TOKEN_SECRET`
   → account secret `musichell-session-token-secret` (already configured in `wrangler.jsonc`).
5. No per-worker `wrangler secret put SESSION_TOKEN_SECRET` is required.
6. Run locally:
   `npm run dev`
7. Deploy when ready:
   `npm run deploy`

## Expected sync request body

```json
{
  "authToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "accountId": "acc_...",
  "steamId": "7656119...",
  "clientVersion": "1.0.0",
  "snapshot": {
    "version": 1,
    "entries": [
      {
        "key": "PlayerSkinId",
        "valueType": "int",
        "intValue": 2,
        "updatedAtUnixMs": 1760000000000,
        "mergePolicy": "newest"
      },
      {
        "key": "player.skins.unlocked",
        "valueType": "string",
        "stringValue": "{\"unlockedSkinIds\":[0,1,2,7]}",
        "updatedAtUnixMs": 1760000000000,
        "mergePolicy": "unlockedUnion"
      },
      {
        "key": "LevelScore_<id>_FloatV2",
        "valueType": "float",
        "floatValue": 133.4,
        "updatedAtUnixMs": 1760000000000,
        "mergePolicy": "maxFloat"
      }
    ]
  }
}
```

## Expected sync response body

```json
{
  "success": true,
  "revision": 4,
  "updatedAtUnixMs": 1760000000123,
  "snapshot": {
    "version": 1,
    "entries": []
  }
}
```

## Commands

- `npm run dev`
- `npm run deploy`
- `npm run cf-typegen`
