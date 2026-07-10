interface Env {
	SAVEDATA_DB: D1Database;
	STEAM_APP_ID: string;
	SESSION_TOKEN_SECRET: SecretsStoreSecret;
	ALLOWED_ORIGIN?: string;
}

interface SessionTokenClaims {
	iss: string;
	aud: string;
	sub: string;
	steamId: string;
	displayName: string;
	iat: number;
	exp: number;
	jti: string;
}

type MergePolicy = 'newest' | 'maxInt' | 'maxFloat' | 'unlockedUnion' | 'seenUnion' | 'leaderboardMax';
type SaveValueType = 'int' | 'float' | 'string';

interface SaveEntry {
	key: string;
	valueType: SaveValueType;
	intValue?: number;
	floatValue?: number;
	stringValue?: string;
	updatedAtUnixMs: number;
	mergePolicy: MergePolicy;
}

interface SaveSnapshot {
	version: number;
	entries: SaveEntry[];
}

interface SyncRequest {
	authToken?: unknown;
	accountId?: unknown;
	steamId?: unknown;
	clientVersion?: unknown;
	snapshot?: unknown;
}

type PlayerSaveRow = {
	account_id: string;
	steam_id: string;
	payload_json: string;
	revision: number;
	updated_at: number;
	client_version: string | null;
};

const sessionTokenIssuer = 'musichell-account-worker';
const sessionTokenAudience = 'musichell-leaderboard-submit';
const maxEntries = 2000;
const maxKeyLength = 180;
const maxStringValueLength = 32_000;
const snapshotVersion = 1;

const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: buildCorsHeaders(request, env),
			});
		}

		if (request.method === 'GET' && url.pathname === '/health') {
			return json(
				{
					success: true,
					worker: 'musichell-savedata-worker',
					status: 'ready',
					storage: 'd1',
				},
				200,
				request,
				env,
			);
		}

		if (request.method === 'GET' && url.pathname === '/api/savedata') {
			return getSaveData(request, env);
		}

		if (request.method === 'POST' && url.pathname === '/api/savedata/sync') {
			return syncSaveData(request, env);
		}

		return json(
			{
				success: false,
				error: 'Not found.',
			},
			404,
			request,
			env,
		);
	},
} satisfies ExportedHandler<Env>;

async function getSaveData(request: Request, env: Env): Promise<Response> {
	const configError = validateEnvironment(env);
	if (configError) {
		return json({ success: false, error: configError }, 500, request, env);
	}

	const authToken = extractAuthTokenFromRequest(request);
	if (!authToken.ok) {
		return json({ success: false, error: authToken.error }, 401, request, env);
	}

	const sessionToken = await verifySessionToken(authToken.value, env);
	if (!sessionToken.success) {
		return json({ success: false, error: sessionToken.error }, 401, request, env);
	}

	const row = await getPlayerSave(env.SAVEDATA_DB, sessionToken.claims.sub);
	if (row == null) {
		return json(
			{
				success: true,
				exists: false,
				revision: 0,
				updatedAtUnixMs: 0,
				snapshot: emptySnapshot(),
			},
			200,
			request,
			env,
		);
	}

	const snapshot = parseStoredSnapshot(row.payload_json);
	return json(
		{
			success: true,
			exists: true,
			revision: row.revision,
			updatedAtUnixMs: row.updated_at,
			snapshot,
		},
		200,
		request,
		env,
	);
}

async function syncSaveData(request: Request, env: Env): Promise<Response> {
	const configError = validateEnvironment(env);
	if (configError) {
		return json({ success: false, error: configError }, 500, request, env);
	}

	let payload: SyncRequest;
	try {
		payload = (await request.json()) as SyncRequest;
	} catch {
		return json({ success: false, error: 'Invalid JSON body.' }, 400, request, env);
	}

	const authToken = normalizeRequiredString(payload.authToken, 'authToken');
	if (!authToken.ok) {
		return json({ success: false, error: authToken.error }, 400, request, env);
	}

	const sessionToken = await verifySessionToken(authToken.value, env);
	if (!sessionToken.success) {
		return json({ success: false, error: sessionToken.error }, 401, request, env);
	}

	const accountIdMatch = matchesOptionalClaim(payload.accountId, 'accountId', sessionToken.claims.sub);
	if (!accountIdMatch.ok) {
		return json({ success: false, error: accountIdMatch.error }, 401, request, env);
	}

	const steamIdMatch = matchesOptionalClaim(payload.steamId, 'steamId', sessionToken.claims.steamId);
	if (!steamIdMatch.ok) {
		return json({ success: false, error: steamIdMatch.error }, 401, request, env);
	}

	const incomingSnapshot = normalizeSnapshot(payload.snapshot);
	if (!incomingSnapshot.ok) {
		return json({ success: false, error: incomingSnapshot.error }, 400, request, env);
	}

	const existingRow = await getPlayerSave(env.SAVEDATA_DB, sessionToken.claims.sub);
	const existingSnapshot = existingRow == null
		? emptySnapshot()
		: parseStoredSnapshot(existingRow.payload_json);

	const mergedSnapshot = mergeSnapshots(existingSnapshot, incomingSnapshot.value);
	const updatedAt = Date.now();
	const nextRevision = (existingRow?.revision ?? 0) + 1;
	const clientVersion = sanitizeClientVersion(payload.clientVersion);
	const payloadJson = JSON.stringify(mergedSnapshot);

	await env.SAVEDATA_DB.prepare(
		`INSERT INTO player_saves (
			account_id,
			steam_id,
			payload_json,
			revision,
			updated_at,
			client_version
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(account_id) DO UPDATE SET
			steam_id = excluded.steam_id,
			payload_json = excluded.payload_json,
			revision = excluded.revision,
			updated_at = excluded.updated_at,
			client_version = excluded.client_version`
	)
		.bind(
			sessionToken.claims.sub,
			sessionToken.claims.steamId,
			payloadJson,
			nextRevision,
			updatedAt,
			clientVersion,
		)
		.run();

	return json(
		{
			success: true,
			exists: true,
			revision: nextRevision,
			updatedAtUnixMs: updatedAt,
			snapshot: mergedSnapshot,
		},
		200,
		request,
		env,
	);
}

function validateEnvironment(env: Env): string | null {
	if (!env.SAVEDATA_DB) {
		return 'SAVEDATA_DB binding is not configured.';
	}

	if (!env.SESSION_TOKEN_SECRET) {
		return 'SESSION_TOKEN_SECRET Secrets Store binding is not configured.';
	}

	return null;
}

async function getPlayerSave(database: D1Database, accountId: string): Promise<PlayerSaveRow | null> {
	const row = await database
		.prepare(
			`SELECT account_id, steam_id, payload_json, revision, updated_at, client_version
			 FROM player_saves
			 WHERE account_id = ?
			 LIMIT 1`
		)
		.bind(accountId)
		.first<PlayerSaveRow>();

	return row ?? null;
}

function emptySnapshot(): SaveSnapshot {
	return {
		version: snapshotVersion,
		entries: [],
	};
}

function parseStoredSnapshot(payloadJson: string): SaveSnapshot {
	try {
		const parsed = JSON.parse(payloadJson) as unknown;
		const normalized = normalizeSnapshot(parsed);
		return normalized.ok ? normalized.value : emptySnapshot();
	} catch {
		return emptySnapshot();
	}
}

function normalizeSnapshot(value: unknown): { ok: true; value: SaveSnapshot } | { ok: false; error: string } {
	if (!value || typeof value !== 'object') {
		return { ok: false, error: 'snapshot is required.' };
	}

	const candidate = value as Partial<SaveSnapshot>;
	if (!Array.isArray(candidate.entries)) {
		return { ok: false, error: 'snapshot.entries must be an array.' };
	}

	if (candidate.entries.length > maxEntries) {
		return { ok: false, error: `snapshot.entries may contain at most ${maxEntries} items.` };
	}

	const entries: SaveEntry[] = [];
	const seenKeys = new Set<string>();

	for (const rawEntry of candidate.entries) {
		const entry = normalizeEntry(rawEntry);
		if (!entry.ok) {
			return entry;
		}

		if (seenKeys.has(entry.value.key)) {
			return { ok: false, error: `Duplicate snapshot key '${entry.value.key}'.` };
		}

		seenKeys.add(entry.value.key);
		entries.push(entry.value);
	}

	return {
		ok: true,
		value: {
			version: snapshotVersion,
			entries,
		},
	};
}

function normalizeEntry(value: unknown): { ok: true; value: SaveEntry } | { ok: false; error: string } {
	if (!value || typeof value !== 'object') {
		return { ok: false, error: 'Each snapshot entry must be an object.' };
	}

	const candidate = value as Partial<SaveEntry>;
	const key = normalizeRequiredString(candidate.key, 'key');
	if (!key.ok) {
		return key;
	}

	if (key.value.length > maxKeyLength) {
		return { ok: false, error: `key exceeds ${maxKeyLength} characters.` };
	}

	const mergePolicy = normalizeMergePolicy(candidate.mergePolicy);
	if (!mergePolicy.ok) {
		return mergePolicy;
	}

	const valueType = normalizeValueType(candidate.valueType);
	if (!valueType.ok) {
		return valueType;
	}

	const updatedAtUnixMs = normalizeUpdatedAt(candidate.updatedAtUnixMs);
	if (!updatedAtUnixMs.ok) {
		return updatedAtUnixMs;
	}

	const entry: SaveEntry = {
		key: key.value,
		valueType: valueType.value,
		updatedAtUnixMs: updatedAtUnixMs.value,
		mergePolicy: mergePolicy.value,
	};

	if (valueType.value === 'int') {
		const intValue = normalizeInt(candidate.intValue, 'intValue');
		if (!intValue.ok) {
			return intValue;
		}

		entry.intValue = intValue.value;
	} else if (valueType.value === 'float') {
		const floatValue = normalizeFloat(candidate.floatValue, 'floatValue');
		if (!floatValue.ok) {
			return floatValue;
		}

		entry.floatValue = floatValue.value;
	} else {
		const stringValue = normalizeRequiredString(candidate.stringValue, 'stringValue');
		if (!stringValue.ok) {
			return stringValue;
		}

		if (stringValue.value.length > maxStringValueLength) {
			return { ok: false, error: `stringValue exceeds ${maxStringValueLength} characters.` };
		}

		entry.stringValue = stringValue.value;
	}

	return { ok: true, value: entry };
}

function mergeSnapshots(existing: SaveSnapshot, incoming: SaveSnapshot): SaveSnapshot {
	const mergedByKey = new Map<string, SaveEntry>();

	for (const entry of existing.entries) {
		mergedByKey.set(entry.key, cloneEntry(entry));
	}

	for (const entry of incoming.entries) {
		const current = mergedByKey.get(entry.key);
		if (current == null) {
			mergedByKey.set(entry.key, cloneEntry(entry));
			continue;
		}

		mergedByKey.set(entry.key, mergeEntries(current, entry));
	}

	const entries = Array.from(mergedByKey.values()).sort((left, right) => left.key.localeCompare(right.key));
	return {
		version: snapshotVersion,
		entries,
	};
}

function mergeEntries(left: SaveEntry, right: SaveEntry): SaveEntry {
	const policy = left.mergePolicy === right.mergePolicy ? left.mergePolicy : preferMergePolicy(left.mergePolicy, right.mergePolicy);

	if (policy === 'unlockedUnion' || policy === 'seenUnion') {
		return mergeIdListUnion(left, right, policy);
	}

	if (policy === 'leaderboardMax') {
		return mergeLeaderboards(left, right);
	}

	if (policy === 'maxInt') {
		return mergeMaxInt(left, right);
	}

	if (policy === 'maxFloat') {
		return mergeMaxFloat(left, right);
	}

	return left.updatedAtUnixMs >= right.updatedAtUnixMs ? cloneEntry(left) : cloneEntry(right);
}

function preferMergePolicy(left: MergePolicy, right: MergePolicy): MergePolicy {
	const priority: MergePolicy[] = ['unlockedUnion', 'seenUnion', 'leaderboardMax', 'maxFloat', 'maxInt', 'newest'];
	for (const policy of priority) {
		if (left === policy || right === policy) {
			return policy;
		}
	}

	return 'newest';
}

function mergeMaxInt(left: SaveEntry, right: SaveEntry): SaveEntry {
	const leftValue = left.valueType === 'int' ? (left.intValue ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
	const rightValue = right.valueType === 'int' ? (right.intValue ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
	const winner = rightValue > leftValue ? right : leftValue > rightValue ? left : left.updatedAtUnixMs >= right.updatedAtUnixMs ? left : right;
	return {
		key: winner.key,
		valueType: 'int',
		intValue: Math.max(leftValue === Number.NEGATIVE_INFINITY ? 0 : leftValue, rightValue === Number.NEGATIVE_INFINITY ? 0 : rightValue),
		updatedAtUnixMs: Math.max(left.updatedAtUnixMs, right.updatedAtUnixMs),
		mergePolicy: 'maxInt',
	};
}

function mergeMaxFloat(left: SaveEntry, right: SaveEntry): SaveEntry {
	const leftValue = left.valueType === 'float'
		? (left.floatValue ?? Number.NEGATIVE_INFINITY)
		: left.valueType === 'int'
			? (left.intValue ?? Number.NEGATIVE_INFINITY)
			: Number.NEGATIVE_INFINITY;
	const rightValue = right.valueType === 'float'
		? (right.floatValue ?? Number.NEGATIVE_INFINITY)
		: right.valueType === 'int'
			? (right.intValue ?? Number.NEGATIVE_INFINITY)
			: Number.NEGATIVE_INFINITY;
	const maxValue = Math.max(
		leftValue === Number.NEGATIVE_INFINITY ? 0 : leftValue,
		rightValue === Number.NEGATIVE_INFINITY ? 0 : rightValue,
	);

	return {
		key: left.key,
		valueType: 'float',
		floatValue: maxValue,
		updatedAtUnixMs: Math.max(left.updatedAtUnixMs, right.updatedAtUnixMs),
		mergePolicy: 'maxFloat',
	};
}

function mergeIdListUnion(left: SaveEntry, right: SaveEntry, policy: 'unlockedUnion' | 'seenUnion'): SaveEntry {
	const fieldName = policy === 'unlockedUnion' ? 'unlockedSkinIds' : 'seenSkinIds';
	const ids = new Set<number>();

	for (const id of extractIdList(left, fieldName)) {
		ids.add(id);
	}

	for (const id of extractIdList(right, fieldName)) {
		ids.add(id);
	}

	const sortedIds = Array.from(ids).filter((value) => Number.isInteger(value)).sort((a, b) => a - b);
	return {
		key: left.key,
		valueType: 'string',
		stringValue: JSON.stringify({ [fieldName]: sortedIds }),
		updatedAtUnixMs: Math.max(left.updatedAtUnixMs, right.updatedAtUnixMs),
		mergePolicy: policy,
	};
}

function extractIdList(entry: SaveEntry, fieldName: string): number[] {
	if (entry.valueType !== 'string' || !entry.stringValue) {
		return [];
	}

	try {
		const parsed = JSON.parse(entry.stringValue) as Record<string, unknown>;
		const values = parsed[fieldName];
		if (!Array.isArray(values)) {
			return [];
		}

		return values
			.map((value) => (typeof value === 'number' ? value : Number.NaN))
			.filter((value) => Number.isInteger(value));
	} catch {
		return [];
	}
}

function mergeLeaderboards(left: SaveEntry, right: SaveEntry): SaveEntry {
	const boards = new Map<string, Map<string, { playerName: string; score: number }>>();

	ingestLeaderboard(boards, left);
	ingestLeaderboard(boards, right);

	const levels = Array.from(boards.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([leaderboardName, players]) => ({
			LeaderboardName: leaderboardName,
			Entries: Array.from(players.values())
				.sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName))
				.map((entry) => ({
					PlayerName: entry.playerName,
					Score: entry.score,
				})),
		}));

	return {
		key: left.key,
		valueType: 'string',
		stringValue: JSON.stringify({ Levels: levels }),
		updatedAtUnixMs: Math.max(left.updatedAtUnixMs, right.updatedAtUnixMs),
		mergePolicy: 'leaderboardMax',
	};
}

function ingestLeaderboard(
	boards: Map<string, Map<string, { playerName: string; score: number }>>,
	entry: SaveEntry,
): void {
	if (entry.valueType !== 'string' || !entry.stringValue) {
		return;
	}

	try {
		const parsed = JSON.parse(entry.stringValue) as {
			Levels?: Array<{
				LeaderboardName?: string;
				Entries?: Array<{ PlayerName?: string; Score?: number }>;
			}>;
		};

		if (!Array.isArray(parsed.Levels)) {
			return;
		}

		for (const level of parsed.Levels) {
			const boardName = typeof level.LeaderboardName === 'string' ? level.LeaderboardName.trim() : '';
			if (!boardName || !Array.isArray(level.Entries)) {
				continue;
			}

			let players = boards.get(boardName);
			if (players == null) {
				players = new Map();
				boards.set(boardName, players);
			}

			for (const levelEntry of level.Entries) {
				const playerName = typeof levelEntry.PlayerName === 'string' ? levelEntry.PlayerName.trim() : '';
				const score = typeof levelEntry.Score === 'number' && Number.isFinite(levelEntry.Score)
					? Math.floor(levelEntry.Score)
					: Number.NaN;
				if (!playerName || !Number.isInteger(score) || score < 0) {
					continue;
				}

				const playerKey = playerName.toLowerCase();
				const existing = players.get(playerKey);
				if (existing == null || score > existing.score) {
					players.set(playerKey, { playerName, score });
				}
			}
		}
	} catch {
		// Ignore malformed leaderboard JSON and keep whatever already merged.
	}
}

function cloneEntry(entry: SaveEntry): SaveEntry {
	return {
		key: entry.key,
		valueType: entry.valueType,
		intValue: entry.intValue,
		floatValue: entry.floatValue,
		stringValue: entry.stringValue,
		updatedAtUnixMs: entry.updatedAtUnixMs,
		mergePolicy: entry.mergePolicy,
	};
}

function extractAuthTokenFromRequest(request: Request): { ok: true; value: string } | { ok: false; error: string } {
	const authorization = request.headers.get('Authorization');
	if (authorization) {
		const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
		if (!match) {
			return { ok: false, error: 'Authorization header must be a Bearer token.' };
		}

		return normalizeRequiredString(match[1], 'authToken');
	}

	const url = new URL(request.url);
	return normalizeRequiredString(url.searchParams.get('authToken'), 'authToken');
}

function normalizeMergePolicy(value: unknown): { ok: true; value: MergePolicy } | { ok: false; error: string } {
	if (typeof value !== 'string') {
		return { ok: false, error: 'mergePolicy must be a string.' };
	}

	switch (value) {
		case 'newest':
		case 'maxInt':
		case 'maxFloat':
		case 'unlockedUnion':
		case 'seenUnion':
		case 'leaderboardMax':
			return { ok: true, value };
		default:
			return { ok: false, error: `Unsupported mergePolicy '${value}'.` };
	}
}

function normalizeValueType(value: unknown): { ok: true; value: SaveValueType } | { ok: false; error: string } {
	if (typeof value !== 'string') {
		return { ok: false, error: 'valueType must be a string.' };
	}

	switch (value) {
		case 'int':
		case 'float':
		case 'string':
			return { ok: true, value };
		default:
			return { ok: false, error: `Unsupported valueType '${value}'.` };
	}
}

function normalizeUpdatedAt(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { ok: false, error: 'updatedAtUnixMs must be a finite number.' };
	}

	const normalized = Math.floor(value);
	if (normalized < 0) {
		return { ok: false, error: 'updatedAtUnixMs must be zero or greater.' };
	}

	return { ok: true, value: normalized };
}

function normalizeInt(value: unknown, fieldName: string): { ok: true; value: number } | { ok: false; error: string } {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { ok: false, error: `${fieldName} must be a finite number.` };
	}

	return { ok: true, value: Math.trunc(value) };
}

function normalizeFloat(value: unknown, fieldName: string): { ok: true; value: number } | { ok: false; error: string } {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { ok: false, error: `${fieldName} must be a finite number.` };
	}

	return { ok: true, value };
}

function sanitizeClientVersion(value: unknown): string {
	if (typeof value !== 'string') {
		return 'unknown';
	}

	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, 32) : 'unknown';
}

function normalizeRequiredString(value: unknown, fieldName: string): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof value !== 'string') {
		return { ok: false, error: `${fieldName} must be a non-empty string.` };
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return { ok: false, error: `${fieldName} must be a non-empty string.` };
	}

	return { ok: true, value: trimmed };
}

function matchesOptionalClaim(
	value: unknown,
	fieldName: string,
	expectedValue: string,
): { ok: true } | { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true };
	}

	const normalized = normalizeRequiredString(value, fieldName);
	if (!normalized.ok) {
		return normalized;
	}

	return normalized.value === expectedValue
		? { ok: true }
		: { ok: false, error: `${fieldName} does not match the authenticated session.` };
}

async function verifySessionToken(
	token: string,
	env: Env,
): Promise<{ success: true; claims: SessionTokenClaims } | { success: false; error: string }> {
	const parts = token.split('.');
	if (parts.length !== 3) {
		return { success: false, error: 'authToken must be a valid signed session token.' };
	}

	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const signingInput = `${encodedHeader}.${encodedPayload}`;

	let header: { alg?: string; typ?: string };
	let claims: SessionTokenClaims;
	let providedSignature: Uint8Array;
	try {
		header = base64UrlDecodeJson<{ alg?: string; typ?: string }>(encodedHeader);
		claims = base64UrlDecodeJson<SessionTokenClaims>(encodedPayload);
		providedSignature = base64UrlDecodeBytes(encodedSignature);
	} catch {
		return { success: false, error: 'authToken is not valid base64url-encoded JSON.' };
	}

	if (header.alg !== 'HS256' || header.typ !== 'JWT') {
		return { success: false, error: 'authToken uses an unsupported signature format.' };
	}

	if (!isValidSessionTokenClaims(claims)) {
		return { success: false, error: 'authToken payload is missing required claims.' };
	}

	const sessionTokenSecret = await env.SESSION_TOKEN_SECRET.get();
	const expectedSignature = await signHmacSha256(signingInput, sessionTokenSecret);
	if (!constantTimeEqual(providedSignature, new Uint8Array(expectedSignature))) {
		return { success: false, error: 'authToken signature is invalid.' };
	}

	if (claims.iss !== sessionTokenIssuer || claims.aud !== sessionTokenAudience) {
		return { success: false, error: 'authToken was not issued for MusicHell cloud services.' };
	}

	const unixNow = Math.floor(Date.now() / 1000);
	if (claims.exp <= unixNow) {
		return { success: false, error: 'authToken has expired.' };
	}

	if (claims.iat > unixNow + 300) {
		return { success: false, error: 'authToken issue time is invalid.' };
	}

	return { success: true, claims };
}

function isValidSessionTokenClaims(value: unknown): value is SessionTokenClaims {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const claims = value as Partial<SessionTokenClaims>;
	return typeof claims.iss === 'string'
		&& typeof claims.aud === 'string'
		&& typeof claims.sub === 'string'
		&& typeof claims.steamId === 'string'
		&& typeof claims.displayName === 'string'
		&& Number.isInteger(claims.iat)
		&& Number.isInteger(claims.exp)
		&& typeof claims.jti === 'string';
}

async function signHmacSha256(message: string, secret: string): Promise<ArrayBuffer> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);

	return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;
	for (let index = 0; index < left.length; index++) {
		diff |= left[index] ^ right[index];
	}

	return diff === 0;
}

function base64UrlDecodeJson<T>(value: string): T {
	return JSON.parse(base64UrlDecodeString(value)) as T;
}

function base64UrlDecodeString(value: string): string {
	const bytes = base64UrlDecodeBytes(value);
	return new TextDecoder().decode(bytes);
}

function base64UrlDecodeBytes(value: string): Uint8Array {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}

	return bytes;
}

function json(payload: unknown, status: number, request: Request, env: Env): Response {
	return new Response(JSON.stringify(payload, null, 2), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			...buildCorsHeaders(request, env),
		},
	});
}

function buildCorsHeaders(request: Request, env: Env): Record<string, string> {
	const headers = { ...corsHeaders };
	const origin = request.headers.get('Origin');

	if (env.ALLOWED_ORIGIN?.trim()) {
		headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN;
	} else if (origin) {
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		headers['Access-Control-Allow-Origin'] = '*';
	}

	return headers;
}
