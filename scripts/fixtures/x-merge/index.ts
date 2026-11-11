<<<<<<< HEAD
  const body = await c.req.json<{ name: string; workerUrl: string; apiKey: string }>();
  if (!body.name || !body.workerUrl || !body.apiKey) return c.json({ success: false, error: 'name, workerUrl, apiKey required' }, 400);
  let workerUrl = body.workerUrl.replace(/\/$/, '');
  if (!workerUrl.startsWith('http://') && !workerUrl.startsWith('https://')) {
    workerUrl = 'https://' + workerUrl;
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare('INSERT INTO line_connections (id, name, worker_url, api_key, created_at) VALUES (?, ?, ?, ?, datetime(\'now\'))').bind(id, body.name, workerUrl, body.apiKey).run();
  return c.json({ success: true, data: { id, name: body.name, workerUrl } }, 201);
=======
  const body = await c.req.json<{
    name: string;
    workerUrl: string;
    apiKey: string;
    integrationSecret?: string;
    lineAccountId?: string;
  }>();
  if (!body.name || !body.workerUrl || !body.apiKey)
    return c.json({ success: false, error: 'name, workerUrl, apiKey required' }, 400);
  let target: URL;
  try {
    target = new URL(body.workerUrl);
  } catch {
    return c.json({ success: false, error: 'Invalid URL' }, 400);
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    return c.json({ success: false, error: 'HTTPS URL required' }, 400);
  if (
    body.integrationSecret &&
    (typeof body.integrationSecret !== 'string' || body.integrationSecret.length < 32)
  )
    return c.json(
      { success: false, error: 'Integration secret must have at least 32 characters' },
      400,
    );
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO line_connections (id, name, worker_url, api_key, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
  )
    .bind(
      id,
      body.name,
      body.workerUrl.replace(/\/$/, ''),
      await encryptSecret(body.apiKey, c.env.ENCRYPTION_KEY),
    )
    .run();
  if (body.integrationSecret)
    await c.env.DB.prepare(
      'UPDATE line_connections SET integration_secret=?,line_account_id=? WHERE id=?',
    )
      .bind(
        await encryptSecret(body.integrationSecret, c.env.ENCRYPTION_KEY),
        body.lineAccountId ?? null,
        id,
      )
      .run();
  return c.json({ success: true, data: { id, name: body.name, workerUrl: body.workerUrl } }, 201);
>>>>>>> v0.10.0
