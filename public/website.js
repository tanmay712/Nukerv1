const revealElements = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries, current) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add('visible'); current.unobserve(entry.target); }
  }), { threshold: 0.12 });
  revealElements.forEach((element) => { element.classList.add('will-reveal'); observer.observe(element); });
} else revealElements.forEach((element) => element.classList.add('visible'));
