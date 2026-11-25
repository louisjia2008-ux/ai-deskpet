/** A motion token's duration in milliseconds as the page resolves it now (reduced motion included); 0 when absent. */
export const motionMs = (token: string, element: Element = document.documentElement): number => {
  const value = window.getComputedStyle(element).getPropertyValue(token).trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith('ms') ? amount : value.endsWith('s') ? amount * 1000 : 0;
};
