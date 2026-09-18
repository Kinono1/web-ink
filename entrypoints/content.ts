import { startContent } from '../src/content/controller';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    const dispose = startContent();
    ctx.onInvalidated(dispose);
  },
});
