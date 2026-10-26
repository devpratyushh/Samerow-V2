import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { FaTimes } from 'react-icons/fa';
import './Dialog.css';

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const subscribeToFullscreen = (callback) => {
  document.addEventListener('fullscreenchange', callback);
  return () => document.removeEventListener('fullscreenchange', callback);
};
const getPortalRoot = () => document.fullscreenElement || document.body;
const getServerRoot = () => null;
let scrollLocks = 0;
let previousOverflow = '';

export default function Dialog({ open, title, onClose, children, description, className = '' }) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef(null);
  const overlayRef = useRef(null);
  const closeRef = useRef(onClose);
  const portalRoot = useSyncExternalStore(subscribeToFullscreen, getPortalRoot, getServerRoot);

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const resize = () => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      overlay.style.setProperty('--sr-dialog-height', `${viewport.height}px`);
      overlay.style.height = `${viewport.height}px`;
      overlay.style.top = `${viewport.offsetTop}px`;
      overlay.style.bottom = 'auto';
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
    };
  }, [open, portalRoot]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    if (!panel) return;
    if (scrollLocks === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
    const isTopDialog = () => [...document.querySelectorAll('.sr-dialog-overlay')].at(-1) === overlayRef.current;
    const getFocusable = () => [...panel.querySelectorAll(focusableSelector)].filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'));
    const focusStart = () => (panel.querySelector('[data-autofocus]') ?? getFocusable()[0] ?? panel).focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      // A user (or password manager) may focus a field before this frame runs.
      if (!panel.contains(document.activeElement)) focusStart();
    });
    const onKeyDown = (event) => {
      if (!isTopDialog()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
      } else if (event.key === 'Tab') {
        const focusable = getFocusable();
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first) {
          event.preventDefault();
          panel.focus();
        } else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onFocus = (event) => {
      if (isTopDialog() && !panel.contains(event.target)) focusStart();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocus);
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open, portalRoot]);

  if (!open || !portalRoot) return null;

  return createPortal(
    <div className="sr-dialog-overlay" ref={overlayRef} onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className={`sr-dialog-panel ${className}`} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
        <header className="sr-dialog-header">
          <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
          <button className="sr-dialog-close" type="button" onClick={onClose} aria-label={`Close ${typeof title === 'string' ? title.toLowerCase() : 'dialog'}`}><FaTimes aria-hidden="true" /></button>
        </header>
        <div className="sr-dialog-body">{children}</div>
      </section>
    </div>,
    portalRoot,
  );
}
