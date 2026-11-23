import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { useDialogHistory } from './dialog-history';

export function useDialogDismiss(close: () => void, enabled = true, fullBackdrop = false) {
  const pressedOutside = useRef(false);

  function outside(event: MouseEvent<HTMLDialogElement>) {
    if (event.target !== event.currentTarget) return false;
    if (fullBackdrop) return true;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX >= bounds.right ||
      event.clientY < bounds.top || event.clientY >= bounds.bottom;
  }

  return {
    onCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
      event.preventDefault();
      if (enabled) close();
    },
    onPointerDown(event: React.PointerEvent<HTMLDialogElement>) {
      pressedOutside.current = event.button === 0 && outside(event);
    },
    onClick(event: MouseEvent<HTMLDialogElement>) {
      const dismiss = pressedOutside.current && outside(event);
      pressedOutside.current = false;
      if (enabled && dismiss) close();
    },
  };
}

export function ModalBackdrop({ children, close, locked = false, className = 'modalBackdrop', label, labelledBy }: {
  children: ReactNode;
  close: () => void;
  locked?: boolean;
  className?: string;
  label?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const handlers = useDialogDismiss(close, !locked, true);
  useDialogHistory(close);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return <dialog ref={ref} className={`orbitModalBackdrop ${className}`}
    aria-label={label} aria-labelledby={labelledBy} {...handlers}>{children}</dialog>;
}
