import { ConfigService } from '@nestjs/config';

import { createApp } from './app.factory.js';

/**
 * Boots the api and listens. Everything that shapes the request pipeline lives
 * in `createApp()` (app.factory.ts) so the pipeline suite boots the same app;
 * only the listener is here, because tests inject instead of listening.
 */
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
