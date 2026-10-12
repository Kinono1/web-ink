import { installIeeePreparation } from '../src/content/ieee-prepare';

export default defineUnlistedScript(() => {
  const scope = window as Window & { __webInkIeeePrepare?: () => void };
  scope.__webInkIeeePrepare?.();
  scope.__webInkIeeePrepare = installIeeePreparation();
});
