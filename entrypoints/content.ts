import { startBootstrap } from '../src/content/bootstrap';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    const dispose = startBootstrap();
    ctx.onInvalidated(dispose);
  },
});
