// Progressive enhancement: keep the page fully readable without JavaScript, then
// add gentle depth and pointer response on devices that support fine pointing.
document.querySelectorAll('.reveal').forEach((element) => element.classList.add('visible'));

const motionOK = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
if (motionOK) document.documentElement.classList.add('motion-ready');

if (motionOK && finePointer) {
  const tilt = (element, max = 5) => {
    let bounds;
    element.addEventListener('pointerenter', () => { bounds = element.getBoundingClientRect(); });
    element.addEventListener('pointermove', (event) => {
      bounds ||= element.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      element.style.setProperty('--pointer-x', `${(x + 0.5) * 100}%`);
      element.style.setProperty('--pointer-y', `${(y + 0.5) * 100}%`);
      element.style.setProperty('--tilt-x', `${-y * max}deg`);
      element.style.setProperty('--tilt-y', `${x * max}deg`);
    });
    element.addEventListener('pointerleave', () => {
      bounds = null;
      element.style.setProperty('--tilt-x', '0deg');
      element.style.setProperty('--tilt-y', '0deg');
    });
  };
  document.querySelectorAll('.hero-visual, .feature-card, .workspace-card').forEach((card) => tilt(card, card.matches('.hero-visual') ? 7 : 3));
}

// Subtle scroll-linked background drift, with no continuous animation loop.
if (motionOK) {
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--page-scroll', `${Math.min(window.scrollY / 900, 1)}`);
      scheduled = false;
    });
  }, { passive: true });
}
