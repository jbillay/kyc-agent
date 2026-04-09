'use strict';

const { buildServer } = require('../../backend/src/index');

describe('Health check endpoint', () => {
  let app;

  beforeEach(async () => {
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  test('GET /api/v1/admin/system/health returns 200 with correct shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/system/health',
    });

    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(typeof body.uptime).toBe('number');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('Error envelope', () => {
  let app;

  beforeEach(async () => {
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
  });

  test('Unknown route returns 404 with standard error envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(res.statusCode).toBe(404);

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});
