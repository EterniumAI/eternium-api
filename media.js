/**
 * Eternium API — R2 Media Storage
 * Upload, serve, and delete files from the MEDIA_STORAGE R2 bucket.
 */

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

const ALLOWED_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
	'.mp4', '.webm', '.pdf',
]);

const ALLOWED_PREFIXES = new Set(['imageforge', 'assets', 'tenants']);

const CONTENT_TYPE_MAP = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.pdf': 'application/pdf',
};

// ── Helpers ────────────────────────────────────────────────────

function sanitizeFilename(name) {
	// Strip path separators, traversal sequences, null bytes, control chars
	return name
		.replace(/\.\./g, '')
		.replace(/\.\//g, '')
		.replace(/[\/\\]/g, '')
		.replace(/[\x00-\x1f]/g, '')
		.replace(/\s+/g, '-')
		.trim();
}

function validateMediaKey(path, filename) {
	const prefix = path.split('/')[0];
	if (!ALLOWED_PREFIXES.has(prefix)) {
		return { error: `Invalid path prefix "${prefix}". Allowed: ${[...ALLOWED_PREFIXES].join(', ')}`, code: 400 };
	}

	const clean = sanitizeFilename(filename);
	if (!clean || clean.startsWith('.')) {
		return { error: 'Invalid filename', code: 400 };
	}

	const ext = '.' + clean.split('.').pop().toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext)) {
		return { error: `File type "${ext}" not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`, code: 400 };
	}

	// Rebuild full key, normalizing slashes
	const fullPath = path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
	const key = `${fullPath}/${clean}`;

	// Final traversal guard
	if (key.includes('..') || key.includes('./')) {
		return { error: 'Invalid path', code: 400 };
	}

	return { key, ext, clean };
}

// ── PUT /v1/media/upload ───────────────────────────────────────

export async function handleMediaUpload(request, env, keyData) {
	if (!env.MEDIA_STORAGE) {
		return { error: 'Media storage not configured', code: 500 };
	}

	let formData;
	try {
		formData = await request.formData();
	} catch {
		return { error: 'Expected multipart/form-data with a "file" field', code: 400 };
	}

	const file = formData.get('file');
	if (!file || typeof file === 'string') {
		return { error: 'Missing "file" field', code: 400 };
	}

	if (file.size > MAX_UPLOAD_SIZE) {
		return { error: `File exceeds ${MAX_UPLOAD_SIZE / 1024 / 1024}MB limit`, code: 413 };
	}

	const path = (formData.get('path') || 'assets').trim();
	const tags = (formData.get('tags') || '').trim();
	const filename = file.name || 'upload';

	const result = validateMediaKey(path, filename);
	if (result.error) return result;

	const contentType = file.type || CONTENT_TYPE_MAP[result.ext] || 'application/octet-stream';

	await env.MEDIA_STORAGE.put(result.key, file.stream(), {
		httpMetadata: { contentType },
		customMetadata: {
			uploadedBy: keyData.email,
			uploadedAt: new Date().toISOString(),
			originalName: filename,
			...(tags ? { tags } : {}),
		},
	});

	return {
		data: {
			key: result.key,
			url: `https://api.eternium.ai/v1/media/${result.key}`,
			size: file.size,
			content_type: contentType,
		},
		code: 201,
	};
}

// ── GET /v1/media/:key+ ───────────────────────────────────────

export async function handleMediaServe(key, env) {
	if (!env.MEDIA_STORAGE) {
		return new Response('Media storage not configured', { status: 500 });
	}

	const obj = await env.MEDIA_STORAGE.get(key);
	if (!obj) {
		return new Response('Not found', { status: 404 });
	}

	const headers = new Headers();
	headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	headers.set('X-Content-Type-Options', 'nosniff');

	return new Response(obj.body, { status: 200, headers });
}

// ── DELETE /v1/media/:key+ ─────────────────────────────────────

export async function handleMediaDelete(key, env, keyData) {
	if (!env.MEDIA_STORAGE) {
		return { error: 'Media storage not configured', code: 500 };
	}

	const obj = await env.MEDIA_STORAGE.head(key);
	if (!obj) {
		return { error: 'Not found', code: 404 };
	}

	// Only the uploader or admin can delete
	const uploadedBy = obj.customMetadata?.uploadedBy;
	const isAdmin = keyData.email === (env.ADMIN_EMAIL || 'ty@eternium.ai');
	if (uploadedBy && uploadedBy !== keyData.email && !isAdmin) {
		return { error: 'Forbidden: you can only delete your own uploads', code: 403 };
	}

	await env.MEDIA_STORAGE.delete(key);
	return { data: { deleted: true, key }, code: 200 };
}
